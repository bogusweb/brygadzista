import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import type { SpecAnswer, SpecPage } from "../src/defect-llm.js";
import { defectSpecsIdle, resumeDefectSpecs } from "../src/defect-spec.js";
import { listDefects } from "../src/defects.js";
import { pageImage } from "../src/storage.js";
import { APP, createDocument, createProject, insertPage, resetDatabase } from "./helpers.js";

const { findDefectSpec, transcribeAudio } = vi.hoisted(() => ({
  findDefectSpec: vi.fn<(defect: { note: string; room: string }, pages: SpecPage[]) => Promise<SpecAnswer>>(),
  transcribeAudio: vi.fn<(audio: Uint8Array, mediaType: string, context?: string) => Promise<string>>(),
}));
vi.mock("../src/defect-llm.js", () => ({ findDefectSpec }));
vi.mock("../src/diary-llm.js", () => ({ transcribeAudio, organizeTranscript: vi.fn() }));

const PAGE_TEXT = "RZUT PARTERU A-05\nParapety okienne na wysokości 90 cm od posadzki\nTynk gipsowy kat. III";

let projectId: string;
let documentId: string;

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
  documentId = await createDocument(projectId, "ready");
  await sql`update documents set page_count = 42 where id = ${documentId}`;
  await insertPage(projectId, documentId, 5, { title: "Rzut parteru", searchText: PAGE_TEXT });
  await insertPage(projectId, documentId, 6, { title: "Rzut piętra", searchText: "RZUT PIĘTRA A-06" });
  findDefectSpec.mockReset().mockResolvedValue({
    found: true,
    statement: "Wg rys. A-05 parapet na wysokości 90 cm",
    quote: "parapety okienne na wysokości 90 cm",
    page: 1,
  });
  transcribeAudio.mockReset().mockResolvedValue("Parapet w salonie za nisko");
  config.openrouterApiKey = "test-key";
});

afterAll(async () => {
  config.openrouterApiKey = "";
  await sql.end();
});

const defectBody = (fields: Record<string, unknown> = {}) => ({
  documentId,
  pageNo: 5,
  x: 0.5,
  y: 0.5,
  kind: "defect",
  note: "Parapet w salonie osadzony za nisko",
  room: "Salon",
  status: "open",
  assignee: "Kowalski",
  dueDate: "2026-10-30",
  createdAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T08:00:00.000Z",
  ...fields,
});

const putPin = (pinId: string, body: object) =>
  app.request(`/api/projects/${projectId}/pins/${pinId}`, {
    method: "PUT",
    headers: { ...APP, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

type ListedPin = { id: string; status: string | null; assignee: string; dueDate: string | null; spec: unknown; photos: { stage: string }[] };

const listPins = async () => ((await (await app.request(`/api/projects/${projectId}/pins`, { headers: APP })).json()) as { pins: ListedPin[] }).pins;

const photo = () => sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 90, b: 200 } } }).jpeg().toBuffer();

describe("defect pins", () => {
  it("keeps status, person and deadline on a defect and none of them on a photo pin", async () => {
    const defectId = randomUUID();
    const photoPinId = randomUUID();

    expect((await putPin(defectId, defectBody())).status).toBe(200);
    await putPin(photoPinId, defectBody({ kind: "photo" }));

    const pins = await listPins();
    expect(pins.find((pin) => pin.id === defectId)).toMatchObject({ status: "open", assignee: "Kowalski", dueDate: "2026-10-30" });
    expect(pins.find((pin) => pin.id === photoPinId)).toMatchObject({ status: null, assignee: "", dueDate: null });
  });

  it("rejects an unknown status and a deadline that is not a day", async () => {
    expect((await putPin(randomUUID(), defectBody({ status: "fixed" }))).status).toBe(400);
    expect((await putPin(randomUUID(), defectBody({ dueDate: "jutro" }))).status).toBe(400);
  });

  it("stores photos from before and after the fix", async () => {
    const pinId = randomUUID();
    await putPin(pinId, defectBody());

    for (const stage of ["before", "after"]) {
      const response = await app.request(`/api/projects/${projectId}/pins/${pinId}/photos/${randomUUID()}?stage=${stage}`, {
        method: "PUT",
        headers: { ...APP, "content-type": "image/jpeg" },
        body: new Uint8Array(await photo()),
      });
      expect(response.status).toBe(201);
    }
    const wrong = await app.request(`/api/projects/${projectId}/pins/${pinId}/photos/${randomUUID()}?stage=during`, {
      method: "PUT",
      headers: { ...APP, "content-type": "image/jpeg" },
      body: new Uint8Array(await photo()),
    });

    expect(wrong.status).toBe(400);
    expect((await listPins())[0]!.photos.map((item) => item.stage).sort()).toEqual(["after", "before"]);
  });
});

describe("what the project says about a defect", () => {
  it("finds it on the defect's own drawing, with a quote that is really there", async () => {
    const pinId = randomUUID();
    await putPin(pinId, defectBody());
    await defectSpecsIdle();

    expect(findDefectSpec.mock.calls[0]![1][0]).toMatchObject({ pageNo: 5, title: "Rzut parteru" });
    expect((await listPins())[0]!.spec).toEqual({
      found: true,
      statement: "Wg rys. A-05 parapet na wysokości 90 cm",
      quote: "parapety okienne na wysokości 90 cm",
      source: { documentId, pageNo: 5, title: "Rzut parteru" },
    });
  });

  it("treats a quote that is not on the page as nothing found", async () => {
    findDefectSpec.mockResolvedValue({ found: true, statement: "Parapet na 85 cm", quote: "parapet 85 cm", page: 1 });
    await putPin(randomUUID(), defectBody());
    await defectSpecsIdle();

    expect((await listPins())[0]!.spec).toMatchObject({ found: false, source: null });
  });

  it("asks again only when the description changes, and keeps the phone's newer edit", async () => {
    const pinId = randomUUID();
    await putPin(pinId, defectBody());
    await defectSpecsIdle();
    await putPin(pinId, defectBody({ status: "to_check", updatedAt: "2026-10-21T09:00:00.000Z" }));
    await defectSpecsIdle();
    expect(findDefectSpec).toHaveBeenCalledTimes(1);

    await putPin(pinId, defectBody({ note: "Parapet w kuchni za nisko", updatedAt: "2026-10-21T10:00:00.000Z" }));
    await defectSpecsIdle();

    expect(findDefectSpec).toHaveBeenCalledTimes(2);
    expect((await listPins())[0]).toMatchObject({ status: "open", spec: { found: true } });
  });

  it("looks up descriptions synced while there was no key after a restart", async () => {
    config.openrouterApiKey = "";
    await putPin(randomUUID(), defectBody());
    await defectSpecsIdle();
    expect((await listPins())[0]!.spec).toBeNull();

    config.openrouterApiKey = "test-key";
    await resumeDefectSpecs();

    expect((await listPins())[0]!.spec).toMatchObject({ found: true });
  });
});

describe("listDefects", () => {
  it("filters by status, person (any case) and page", async () => {
    await putPin(randomUUID(), defectBody({ room: "Salon" }));
    // A minute later, so the order within the page does not depend on how Postgres happens to return equal times.
    await putPin(randomUUID(), defectBody({ room: "Kuchnia", status: "closed", assignee: "Nowak", createdAt: "2026-10-21T08:01:00.000Z" }));
    await putPin(randomUUID(), defectBody({ room: "Sypialnia", pageNo: 6 }));
    await defectSpecsIdle();

    const rooms = async (filter: Parameters<typeof listDefects>[1]) => (await listDefects(projectId, filter)).map((defect) => defect.room);

    expect(await rooms({})).toEqual(["Salon", "Kuchnia", "Sypialnia"]);
    expect(await rooms({ statuses: ["open"] })).toEqual(["Salon", "Sypialnia"]);
    expect(await rooms({ assignee: "nowak" })).toEqual(["Kuchnia"]);
    expect(await rooms({ documentId, pageNo: 6 })).toEqual(["Sypialnia"]);
    expect((await listDefects(projectId, { pageNo: 6 }))[0]).toMatchObject({ pageTitle: "Rzut piętra" });
  });
});

describe("acceptance protocol", () => {
  it("is a PDF with the defects, the spot on the drawing and Polish letters", async () => {
    await mkdir(path.dirname(pageImage(documentId, 5)), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).jpeg().toFile(pageImage(documentId, 5));
    const pinId = randomUUID();
    await putPin(pinId, defectBody());
    await putPin(randomUUID(), defectBody({ room: "Kuchnia", status: "closed" }));
    await app.request(`/api/projects/${projectId}/pins/${pinId}/photos/${randomUUID()}`, {
      method: "PUT",
      headers: { ...APP, "content-type": "image/jpeg" },
      body: new Uint8Array(await photo()),
    });
    await defectSpecsIdle();

    const response = await app.request(`/api/projects/${projectId}/defects/protocol.pdf?status=open&token=test-app`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    const file = path.join(tmpdir(), `protokol-${randomUUID()}.pdf`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const { stdout } = await promisify(execFile)("pdftotext", ["-enc", "UTF-8", file, "-"]);
    expect(stdout).toContain("Protokół odbioru – lista usterek");
    expect(stdout).toContain("Parapet w salonie osadzony za nisko");
    expect(stdout).toContain("Wg rys. A-05 parapet na wysokości 90 cm");
    expect(stdout).toContain("Miejsce na rzucie");
    expect(stdout).not.toContain("Kuchnia");
  });

  it("needs access to the project", async () => {
    expect((await app.request(`/api/projects/${projectId}/defects/protocol.pdf`)).status).toBe(401);
  });
});

describe("reporting a defect by voice", () => {
  it("turns a recording into the description", async () => {
    const response = await app.request(`/api/projects/${projectId}/transcribe`, {
      method: "POST",
      headers: { ...APP, "content-type": "audio/mp4" },
      body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    });

    expect(await response.json()).toEqual({ text: "Parapet w salonie za nisko" });
    expect(transcribeAudio.mock.calls[0]![2]).toContain("usterki");
  });

  it("refuses a format the model cannot hear", async () => {
    const response = await app.request(`/api/projects/${projectId}/transcribe`, {
      method: "POST",
      headers: { ...APP, "content-type": "audio/webm" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(415);
  });
});
