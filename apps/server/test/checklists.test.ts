import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import type { ChecklistFinding, ChecklistSourcePage } from "../src/llm.js";
import { ADMIN, APP, addMember, createDocument, createProject, createUser, insertPage, login, resetDatabase } from "./helpers.js";

const { embed, readChecklistValue } = vi.hoisted(() => ({
  embed: vi.fn<(texts: string[]) => Promise<number[][]>>(),
  readChecklistValue: vi.fn<(ask: string, pages: ChecklistSourcePage[]) => Promise<ChecklistFinding | null>>(),
}));
vi.mock("../src/llm.js", () => ({ embed, readChecklistValue, agentLanguageModel: vi.fn(), askAboutPage: vi.fn() }));

const STROP_PAGE = "Strop gęstożebrowy, grubość płyty 24 cm. Beton C25/30 dla stropu i wieńca. Otulina zbrojenia stropu 25 mm.";

type Item = { id: string; label: string; value: string | null; status: string; checked: boolean; note: string | null; checkedBy: string | null; source: { pageNo: number; quote: string } | null };
type Checklist = { id: string; status: string; title: string; items: Item[]; results: { completedBy: string; items: { label: string; checked: boolean }[] }[] };

let projectId: string;
let documentId: string;

beforeEach(async () => {
  await resetDatabase();
  embed.mockReset().mockImplementation(async (texts) => texts.map(() => Array.from({ length: config.embeddingDimensions }, () => 0)));
  readChecklistValue.mockReset().mockResolvedValue(null);
  projectId = await createProject();
  documentId = await createDocument(projectId, "ready");
  await insertPage(projectId, documentId, 1, { title: "Opis techniczny", searchText: "Opis techniczny budynku mieszkalnego jednorodzinnego." });
  await insertPage(projectId, documentId, 7, { title: "Strop nad parterem", searchText: STROP_PAGE, indexed: true });
});

afterEach(() => {
  config.openrouterApiKey = "";
});

afterAll(async () => {
  await sql.end();
});

const createChecklist = (stage: string, headers: Record<string, string> = APP, project = projectId) =>
  app.request(`/api/projects/${project}/checklists`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ stage }),
  });

const getChecklist = async (id: string, headers: Record<string, string> = APP) =>
  (await (await app.request(`/api/checklists/${id}`, { headers })).json()) as Checklist;

const readyChecklist = async (stage = "strop", headers: Record<string, string> = APP) => {
  const response = await createChecklist(stage, headers);
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  await expect.poll(async () => (await getChecklist(id, headers)).status).not.toBe("generating");
  return getChecklist(id, headers);
};

const sync = (id: string, events: object[], headers: Record<string, string> = APP) =>
  app.request(`/api/checklists/${id}/sync`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });

const byLabel = (checklist: Checklist, label: string) => checklist.items.find((item) => item.label === label)!;

describe("checklist templates", () => {
  it("lists the stages of a single-family house", async () => {
    const response = await app.request("/api/checklist-templates", { headers: APP });

    expect(response.status).toBe(200);
    const stages = ((await response.json()) as { stage: string }[]).map((template) => template.stage);
    expect(stages).toEqual(["fundamenty", "sciany", "strop", "dach", "instalacje", "tynki", "wylewki", "szkielet", "ocieplenie", "stolarka"]);
  });
});

describe("generating a checklist", () => {
  it("rejects an unknown stage and a project with no indexed pages", async () => {
    expect((await createChecklist("piwnica")).status).toBe(400);
    const empty = await createProject("Pusty");

    const response = await createChecklist("strop", APP, empty);

    expect(response.status).toBe(409);
  });

  it("without a model key marks every item to confirm and points at the page where the topic is", async () => {
    const checklist = await readyChecklist();

    expect(checklist).toMatchObject({ status: "ready", title: "Strop i wieniec" });
    expect(checklist.items).toHaveLength(9);
    expect(checklist.items.every((item) => item.status === "to_confirm" && item.value === null)).toBe(true);
    expect(byLabel(checklist, "Otulina zbrojenia").source).toMatchObject({ pageNo: 7, quote: expect.stringContaining("Otulina") });
    expect(byLabel(checklist, "Podparcie i rozszalowanie").source).toBeNull();
    expect(readChecklistValue).not.toHaveBeenCalled();
  });

  it("keeps a value as found only when its quote is on the cited page", async () => {
    config.openrouterApiKey = "test-key";
    readChecklistValue.mockImplementation(async (ask, pages) => {
      const page = pages.find((candidate) => candidate.pageNo === 7);
      if (!page) return null;
      if (ask.includes("otuliny")) return { value: "25 mm", documentId: page.documentId, pageNo: 7, quote: "Otulina zbrojenia stropu 25 mm." };
      if (ask.includes("klasa betonu")) return { value: "C30/37", documentId: page.documentId, pageNo: 7, quote: "Beton C30/37 w stropie." };
      return null;
    });

    const checklist = await readyChecklist();

    expect(byLabel(checklist, "Otulina zbrojenia")).toMatchObject({
      value: "25 mm",
      status: "found",
      source: { pageNo: 7, quote: "Otulina zbrojenia stropu 25 mm." },
    });
    expect(byLabel(checklist, "Klasa betonu stropu i wieńca")).toMatchObject({ value: "C30/37", status: "to_confirm", source: { pageNo: 7 } });
  });

  it("marks the checklist as failed when the model keeps failing", async () => {
    config.openrouterApiKey = "test-key";
    readChecklistValue.mockRejectedValue(new Error("OpenRouter 402"));

    const checklist = await readyChecklist();

    expect(checklist.status).toBe("error");
    expect(checklist.items).toHaveLength(0);
  });
});

describe("ticking a checklist", () => {
  it("records who ticked an item and when, and applies a resent change once", async () => {
    const owner = await createUser("jan@example.com", "contractor");
    await addMember(projectId, owner);
    const jan = await login("jan@example.com");
    const checklist = await readyChecklist("strop", jan);
    const item = byLabel(checklist, "Otulina zbrojenia");
    const tick = { id: randomUUID(), type: "check", itemId: item.id, checked: true, note: "dystanse 25 mm", at: "2026-10-21T08:00:00Z" };

    expect((await sync(checklist.id, [tick], jan)).status).toBe(200);
    await sync(checklist.id, [{ ...tick, id: randomUUID(), checked: false, note: null, at: "2026-10-21T09:00:00Z" }], jan);
    const response = await sync(checklist.id, [tick], jan);

    expect(byLabel((await response.json()) as Checklist, "Otulina zbrojenia")).toMatchObject({ checked: false, note: null, checkedBy: "jan" });
  });

  it("keeps the latest change by the time it was made, even when an older one arrives later", async () => {
    const checklist = await readyChecklist();
    const itemId = byLabel(checklist, "Wieniec").id;

    await sync(checklist.id, [{ id: randomUUID(), type: "check", itemId, checked: true, at: "2026-10-21T10:00:00Z" }]);
    await sync(checklist.id, [{ id: randomUUID(), type: "check", itemId, checked: false, at: "2026-10-21T07:00:00Z" }]);

    expect(byLabel(await getChecklist(checklist.id), "Wieniec").checked).toBe(true);
  });

  it("saves the result with the date, the person and the state of every item", async () => {
    const checklist = await readyChecklist("strop", ADMIN);
    const itemId = byLabel(checklist, "Grubość stropu").id;

    const response = await sync(
      checklist.id,
      [
        { id: randomUUID(), type: "complete", at: "2026-10-21T12:00:00Z" },
        { id: randomUUID(), type: "check", itemId, checked: true, at: "2026-10-21T11:00:00Z" },
      ],
      ADMIN,
    );

    const [result] = ((await response.json()) as Checklist).results;
    expect(result).toMatchObject({ completedBy: "Administrator", completedAt: "2026-10-21T12:00:00.000Z" });
    expect(result!.items).toHaveLength(9);
    expect(result!.items.find((item) => item.label === "Grubość stropu")).toMatchObject({ checked: true });
  });

  it("rejects an item from another checklist and malformed changes", async () => {
    const strop = await readyChecklist("strop");
    const dach = await readyChecklist("dach");

    const foreign = await sync(strop.id, [{ id: randomUUID(), type: "check", itemId: dach.items[0]!.id, checked: true, at: "2026-10-21T08:00:00Z" }]);
    const malformed = await sync(strop.id, [{ id: "1", type: "check", checked: "tak" }]);

    expect(foreign.status).toBe(400);
    expect(malformed.status).toBe(400);
  });
});

describe("checklist access", () => {
  it("hides checklists of projects a contractor is not a member of", async () => {
    const checklist = await readyChecklist("strop", ADMIN);
    await createUser("obcy@example.com", "contractor");
    const stranger = await login("obcy@example.com");

    expect((await app.request(`/api/checklists/${checklist.id}`, { headers: stranger })).status).toBe(404);
    expect((await app.request(`/api/projects/${projectId}/checklists`, { headers: stranger })).status).toBe(404);
    expect((await sync(checklist.id, [], stranger)).status).toBe(404);
  });

  it("lists checklists with progress, and only an admin deletes them", async () => {
    const checklist = await readyChecklist();
    await sync(checklist.id, [{ id: randomUUID(), type: "check", itemId: checklist.items[0]!.id, checked: true, at: "2026-10-21T08:00:00Z" }]);

    const list = await (await app.request(`/api/projects/${projectId}/checklists`, { headers: APP })).json();

    expect(list).toEqual([expect.objectContaining({ id: checklist.id, stage: "strop", itemCount: 9, checkedCount: 1, toConfirmCount: 9 })]);
    expect((await app.request(`/api/checklists/${checklist.id}`, { method: "DELETE", headers: APP })).status).toBe(401);
    expect((await app.request(`/api/checklists/${checklist.id}`, { method: "DELETE", headers: ADMIN })).status).toBe(204);
  });
});
