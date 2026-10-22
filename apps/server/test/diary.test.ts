import { existsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { audioType, diaryEntrySchema, fakeOrganize, type DiaryEntry } from "../src/diary-entry.js";
import { diaryIdle, resumeDiaryEntries } from "../src/diary.js";
import { HttpError } from "../src/retry.js";
import { ADMIN, APP, addMember, createDocument, createProject, createUser, insertPage, login, resetDatabase } from "./helpers.js";

const { transcribeAudio, organizeTranscript } = vi.hoisted(() => ({
  transcribeAudio: vi.fn<(audio: Uint8Array, mediaType: string) => Promise<string>>(),
  organizeTranscript: vi.fn<(transcript: string, pages: { documentId: string; pageNo: number; title: string | null }[]) => Promise<DiaryEntry>>(),
}));
vi.mock("../src/diary-llm.js", () => ({ transcribeAudio, organizeTranscript }));

const TRANSCRIPT = "Zalaliśmy ławy fundamentowe. Przyszła dostawa bloczków. Padało od 14.";

const ENTRY: DiaryEntry = {
  summary: "Zabetonowano ławy fundamentowe",
  work: ["Zabetonowano ławy fundamentowe"],
  people: [],
  crew: [],
  deliveries: ["Bloczki betonowe"],
  weather: "Opady deszczu od 14:00",
  problems: [],
  references: [],
};

const AUDIO: Uint8Array<ArrayBuffer> = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);

let projectId: string;

const postAudio = (body: Uint8Array<ArrayBuffer>, query = "date=2026-10-21", headers: Record<string, string> = APP, type = "audio/mp4") =>
  app.request(`/api/projects/${projectId}/diary?${query}`, { method: "POST", body, headers: { ...headers, "content-type": type } });

const postText = (fields: Record<string, unknown>, headers: Record<string, string> = APP) =>
  app.request(`/api/projects/${projectId}/diary`, {
    method: "POST",
    body: JSON.stringify(fields),
    headers: { ...headers, "content-type": "application/json" },
  });

const list = async () => (await (await app.request(`/api/projects/${projectId}/diary`, { headers: APP })).json()) as Record<string, unknown>[];

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
  transcribeAudio.mockReset().mockResolvedValue(TRANSCRIPT);
  organizeTranscript.mockReset().mockResolvedValue(ENTRY);
  config.openrouterApiKey = "test-key";
});

afterAll(async () => {
  config.openrouterApiKey = "";
  await sql.end();
});

describe("audioType", () => {
  it("accepts what the phone and Safari record and drops codec parameters", () => {
    expect(audioType("audio/mp4")).toEqual({ mediaType: "audio/mp4", extension: "m4a" });
    expect(audioType("audio/ogg; codecs=opus")).toEqual({ mediaType: "audio/ogg", extension: "ogg" });
  });

  it("rejects WebM, which the model does not take", () => {
    expect(audioType("audio/webm;codecs=opus")).toBeNull();
    expect(audioType(undefined)).toBeNull();
  });
});

describe("voice note", () => {
  it("saves the recording, transcribes it and sorts the day", async () => {
    const response = await postAudio(AUDIO);
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; status: string; entryDate: string };
    expect(created).toMatchObject({ entryDate: "2026-10-21", status: expect.stringMatching(/queued|processing/) });

    await diaryIdle();

    expect(transcribeAudio).toHaveBeenCalledWith(AUDIO, "audio/mp4");
    expect(organizeTranscript).toHaveBeenCalledWith(TRANSCRIPT, []);
    expect(await list()).toEqual([
      expect.objectContaining({ id: created.id, source: "audio", transcript: TRANSCRIPT, entry: ENTRY, status: "ready", edited: false }),
    ]);
  });

  it("offers the model pages of the project that the note mentions", async () => {
    const documentId = await createDocument(projectId, "ready");
    await insertPage(projectId, documentId, 7, { title: "Rzut fundamentów", searchText: "Rzut fundamentów ławy fundamentowe", indexed: true });
    await insertPage(projectId, documentId, 9, { title: "Dach", searchText: "Więźba dachowa krokwie", indexed: true });

    await postAudio(AUDIO);
    await diaryIdle();

    expect(organizeTranscript).toHaveBeenCalledWith(TRANSCRIPT, [{ documentId, pageNo: 7, title: "Rzut fundamentów" }]);
  });

  it("keeps the first copy when the offline queue sends the same note again", async () => {
    const first = (await (await postAudio(AUDIO, "date=2026-10-21&clientId=nagranie-1")).json()) as { id: string };
    const again = await postAudio(AUDIO, "date=2026-10-21&clientId=nagranie-1");
    await diaryIdle();

    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(first.id);
    expect(await list()).toHaveLength(1);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it("rejects a format the model cannot hear", async () => {
    const response = await postAudio(AUDIO, "date=2026-10-21", APP, "audio/webm");
    expect(response.status).toBe(415);
    expect(await list()).toHaveLength(0);
  });

  it("rejects a recording over the size limit", async () => {
    const limit = config.diaryMaxAudioBytes;
    config.diaryMaxAudioBytes = 4;
    try {
      expect((await postAudio(AUDIO)).status).toBe(413);
    } finally {
      config.diaryMaxAudioBytes = limit;
    }
  });

  it("records a failed model call and sorts it again from the saved audio on retry", async () => {
    transcribeAudio.mockRejectedValueOnce(new HttpError("Payment required", 402));
    const { id } = (await (await postAudio(AUDIO)).json()) as { id: string };
    await diaryIdle();
    expect(await list()).toEqual([expect.objectContaining({ status: "error", error: expect.stringContaining("limit budżetu") })]);

    const retry = await app.request(`/api/diary/${id}/retry`, { method: "POST", headers: APP });
    expect(retry.status).toBe(202);
    await diaryIdle();

    expect(await list()).toEqual([expect.objectContaining({ status: "ready", transcript: TRANSCRIPT, entry: ENTRY })]);
  });

  it("says so when the recording has no speech", async () => {
    transcribeAudio.mockResolvedValueOnce("");
    await postAudio(AUDIO);
    await diaryIdle();

    expect(await list()).toEqual([expect.objectContaining({ status: "error", error: expect.stringContaining("Nie słychać mowy") })]);
    expect(organizeTranscript).not.toHaveBeenCalled();
  });

  it("picks up notes interrupted by a restart", async () => {
    await sql`
      insert into diary_entries (project_id, entry_date, source, transcript, status)
      values (${projectId}, '2026-10-20', 'text', ${TRANSCRIPT}, 'processing')`;

    await resumeDiaryEntries();

    expect(await list()).toEqual([expect.objectContaining({ status: "ready", entry: ENTRY })]);
  });
});

describe("typed note", () => {
  it("sorts typed text without transcription", async () => {
    const response = await postText({ text: TRANSCRIPT, date: "2026-10-20" });
    expect(response.status).toBe(201);
    await diaryIdle();

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(await list()).toEqual([expect.objectContaining({ source: "text", entryDate: "2026-10-20", status: "ready" })]);
  });

  it("rejects an empty note and a bad date", async () => {
    expect((await postText({ text: "  " })).status).toBe(400);
    expect((await postText({ text: TRANSCRIPT, date: "wczoraj" })).status).toBe(400);
  });

  it("lists days newest first", async () => {
    await postText({ text: "Dzień pierwszy", date: "2026-10-19" });
    await postText({ text: "Dzień trzeci", date: "2026-10-21" });
    await postText({ text: "Dzień drugi", date: "2026-10-20" });
    await diaryIdle();

    expect((await list()).map((entry) => entry.entryDate)).toEqual(["2026-10-21", "2026-10-20", "2026-10-19"]);
  });
});

describe("editing", () => {
  const create = async () => {
    const { id } = (await (await postText({ text: TRANSCRIPT, date: "2026-10-21" })).json()) as { id: string };
    await diaryIdle();
    return id;
  };

  const patch = (id: string, body: unknown, headers: Record<string, string> = APP) =>
    app.request(`/api/diary/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { ...headers, "content-type": "application/json" } });

  it("saves a corrected entry and date and marks it as edited", async () => {
    const id = await create();
    const corrected = { ...ENTRY, problems: ["Brak stali na wieniec"] };

    const response = await patch(id, { entry: corrected, entryDate: "2026-10-20" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entry: corrected, entryDate: "2026-10-20", edited: true });
  });

  it("rejects an entry that does not fit the shape", async () => {
    const id = await create();
    expect((await patch(id, { entry: { summary: 1 } })).status).toBe(400);
  });

  it("sorts again from a corrected transcript", async () => {
    const id = await create();
    await patch(id, { transcript: "Murowanie ścian parteru." });

    await app.request(`/api/diary/${id}/retry`, { method: "POST", headers: APP });
    await diaryIdle();

    expect(organizeTranscript).toHaveBeenLastCalledWith("Murowanie ścian parteru.", []);
  });

  it("deletes an entry with its recording", async () => {
    const { id } = (await (await postAudio(AUDIO)).json()) as { id: string };
    await diaryIdle();
    const [{ audio_file: file }] = await sql<{ audio_file: string }[]>`select audio_file from diary_entries where id = ${id}`;
    expect(existsSync(file)).toBe(true);

    expect((await app.request(`/api/diary/${id}`, { method: "DELETE", headers: APP })).status).toBe(204);

    expect(existsSync(file)).toBe(false);
    expect(await list()).toHaveLength(0);
  });
});

describe("access", () => {
  it("hides another project's diary from a contractor", async () => {
    const otherProject = await createProject("Inna budowa");
    const userId = await createUser("ekipa@example.com", "contractor");
    await addMember(otherProject, userId);
    const contractor = await login("ekipa@example.com");
    const { id } = (await (await postText({ text: TRANSCRIPT }, ADMIN)).json()) as { id: string };
    await diaryIdle();

    expect((await app.request(`/api/projects/${projectId}/diary`, { headers: contractor })).status).toBe(404);
    expect((await app.request(`/api/diary/${id}`, { method: "DELETE", headers: contractor })).status).toBe(404);
  });

  it("signs the entry with the account that recorded it", async () => {
    const userId = await createUser("brygadzista@example.com", "contractor");
    await addMember(projectId, userId);
    const contractor = await login("brygadzista@example.com");

    await postText({ text: TRANSCRIPT }, contractor);
    await diaryIdle();

    expect(await list()).toEqual([expect.objectContaining({ authorName: "brygadzista" })]);
  });
});

describe("fakeOrganize", () => {
  it("sorts sentences by keyword for keyless testing", () => {
    const entry = fakeOrganize("Zalaliśmy ławy. Przyszła dostawa bloczków. Padało od 14. Brakuje stali.", []);
    expect(entry).toMatchObject({
      work: ["Zalaliśmy ławy"],
      deliveries: ["Przyszła dostawa bloczków"],
      weather: "Padało od 14",
      problems: ["Brakuje stali"],
      crew: [],
    });
  });

  it("counts crews named with a number", () => {
    const entry = fakeOrganize("Było nas sześciu, czterech zbrojarzy i dwóch na betonie. Przyszły dwie palety bloczków.", []);
    expect(entry.crew).toEqual([
      { team: "zbrojarzy", company: null, count: 4 },
      { team: "betonie", company: null, count: 2 },
    ]);
  });
});

describe("diaryEntrySchema", () => {
  it("gives entries saved before crews an empty crew list", () => {
    const { crew: _crew, ...old } = ENTRY;
    expect(diaryEntrySchema.parse(old).crew).toEqual([]);
  });
});
