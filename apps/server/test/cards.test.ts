import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { cardSettled } from "../src/cards.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import type { ChecklistFinding, ChecklistSourcePage, LayerFinding } from "../src/llm.js";
import { ADMIN, APP, createDocument, createProject, createTenant, createUser, insertPage, login, resetDatabase } from "./helpers.js";

const { embed, readChecklistValue, readLayers } = vi.hoisted(() => ({
  embed: vi.fn<(texts: string[]) => Promise<number[][]>>(),
  readChecklistValue: vi.fn<(ask: string, pages: ChecklistSourcePage[]) => Promise<ChecklistFinding | null>>(),
  readLayers: vi.fn<(name: string, pages: ChecklistSourcePage[]) => Promise<LayerFinding[]>>(),
}));
vi.mock("../src/llm.js", () => ({ embed, readChecklistValue, readLayers, agentLanguageModel: vi.fn(), askAboutPage: vi.fn() }));

const ROOMS_PAGE =
  "Zestawienie pomieszczeń parteru. 1.04 Łazienka powierzchnia 6,20 m2, wysokość w świetle 2,60 m, posadzka płytki gresowe. " +
  "Rzędna posadzki ±0,00.";
const WALL_PAGE =
  "Ściana zewnętrzna SZ1: tynk cienkowarstwowy 0,5 cm, wełna mineralna gr. 15 cm, bloczek z betonu komórkowego gr. 24 cm, " +
  "tynk gipsowy 1,5 cm. Współczynnik przenikania ciepła U=0,18 W/m2K.";

type Source = { pageNo: number; quote: string | null; imagePath: string };
type Field = { key: string; label: string; value: string | null; status: string; source: Source | null };
type Card = {
  id: string;
  kind: string;
  name: string;
  status: string;
  fields: Field[];
  layers: { material: string; thickness: string | null; status: string; source: Source | null }[];
  missing: string[];
};

let projectId: string;
let documentId: string;

beforeEach(async () => {
  await resetDatabase();
  embed.mockReset().mockImplementation(async (texts) => texts.map(() => Array.from({ length: config.embeddingDimensions }, () => 0)));
  readChecklistValue.mockReset().mockResolvedValue(null);
  readLayers.mockReset().mockResolvedValue([]);
  projectId = await createProject();
  documentId = await createDocument(projectId, "ready");
  await insertPage(projectId, documentId, 3, { title: "Zestawienie pomieszczeń", searchText: ROOMS_PAGE, indexed: true });
  await insertPage(projectId, documentId, 8, { title: "Przekrój ściany SZ1", searchText: WALL_PAGE, indexed: true });
});

afterEach(() => {
  config.openrouterApiKey = "";
});

afterAll(async () => {
  await sql.end();
});

const requestCard = (body: object, headers: Record<string, string> = APP, project = projectId) =>
  app.request(`/api/projects/${project}/cards`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getCard = async (id: string, headers: Record<string, string> = APP) =>
  (await (await app.request(`/api/cards/${id}`, { headers })).json()) as Card;

const readyCard = async (body: object, headers: Record<string, string> = APP) => {
  const response = await requestCard(body, headers);
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  await cardSettled(id);
  return getCard(id, headers);
};

const field = (card: Card, key: string) => card.fields.find((candidate) => candidate.key === key)!;

describe("room and partition cards", () => {
  it("rejects a card without a name or kind and a project with no indexed pages", async () => {
    expect((await requestCard({ kind: "room", name: " " })).status).toBe(400);
    expect((await requestCard({ kind: "garage", name: "Garaż" })).status).toBe(400);
    const empty = await createProject("Pusty");

    expect((await requestCard({ kind: "room", name: "Łazienka" }, APP, empty)).status).toBe(409);
  });

  it("without a model key lists every value as missing and points at the page where the room is", async () => {
    const card = await readyCard({ kind: "room", name: "Łazienka 1.04" });

    expect(card).toMatchObject({ kind: "room", name: "Łazienka 1.04", status: "ready" });
    expect(card.fields.map((item) => item.key)).toEqual(["dimensions", "height", "area", "floorLevel", "floor", "windows", "doors", "installations"]);
    expect(card.fields.every((item) => item.status === "to_confirm" && item.value === null)).toBe(true);
    expect(field(card, "area").source).toMatchObject({ pageNo: 3, imagePath: `/api/documents/${documentId}/pages/3/image` });
    expect(card.missing).toContain("Powierzchnia");
    expect(readChecklistValue).not.toHaveBeenCalled();
  });

  it("keeps a value as found only with its quote on the cited page, and asks about the named room", async () => {
    config.openrouterApiKey = "test-key";
    readChecklistValue.mockImplementation(async (ask, pages) => {
      const page = pages.find((candidate) => candidate.pageNo === 3);
      if (!page || !ask.includes("Łazienka 1.04")) return null;
      if (ask.startsWith("powierzchnia")) return { value: "6,20 m2", documentId: page.documentId, pageNo: 3, quote: "1.04 Łazienka powierzchnia 6,20 m2" };
      if (ask.startsWith("wysokość")) return { value: "2,70 m", documentId: page.documentId, pageNo: 3, quote: "wysokość w świetle 2,70 m" };
      return null;
    });

    const card = await readyCard({ kind: "room", name: "Łazienka 1.04" });

    expect(field(card, "area")).toMatchObject({ value: "6,20 m2", status: "found", source: { pageNo: 3, quote: "1.04 Łazienka powierzchnia 6,20 m2" } });
    expect(field(card, "height")).toMatchObject({ value: "2,70 m", status: "to_confirm" });
    expect(card.missing).not.toContain("Powierzchnia");
    expect(card.missing).not.toContain("Wysokość");
  });

  it("lists the layers of a partition with their thickness, and marks a layer with a made-up quote to confirm", async () => {
    config.openrouterApiKey = "test-key";
    readLayers.mockImplementation(async (name, pages) => {
      const page = pages.find((candidate) => candidate.pageNo === 8)!;
      expect(name).toBe("Ściana zewnętrzna SZ1");
      return [
        { material: "wełna mineralna", thickness: "15 cm", documentId: page.documentId, pageNo: 8, quote: "wełna mineralna gr. 15 cm" },
        { material: "bloczek z betonu komórkowego", thickness: "24 cm", documentId: page.documentId, pageNo: 8, quote: "bloczek z betonu komórkowego gr. 24 cm" },
        { material: "styropian grafitowy", thickness: "20 cm", documentId: page.documentId, pageNo: 8, quote: "styropian grafitowy 20 cm" },
      ];
    });
    readChecklistValue.mockImplementation(async (ask, pages) => {
      const page = pages.find((candidate) => candidate.pageNo === 8);
      return page && ask.startsWith("współczynnik") ? { value: "0,18 W/m2K", documentId: page.documentId, pageNo: 8, quote: "U=0,18 W/m2K" } : null;
    });

    const card = await readyCard({ kind: "partition", name: "Ściana  zewnętrzna SZ1 " });

    expect(card.name).toBe("Ściana zewnętrzna SZ1");
    expect(card.layers).toEqual([
      expect.objectContaining({ material: "wełna mineralna", thickness: "15 cm", status: "found", source: expect.objectContaining({ pageNo: 8 }) }),
      expect.objectContaining({ material: "bloczek z betonu komórkowego", thickness: "24 cm", status: "found" }),
      expect.objectContaining({ material: "styropian grafitowy", status: "to_confirm" }),
    ]);
    expect(field(card, "u")).toMatchObject({ value: "0,18 W/m2K", status: "found" });
  });

  it("returns the same card for the same place and collects it again on refresh", async () => {
    const first = await readyCard({ kind: "room", name: "Łazienka 1.04" });
    const again = await readyCard({ kind: "room", name: "łazienka 1.04" });
    expect(again.id).toBe(first.id);
    expect(readChecklistValue).not.toHaveBeenCalled();

    config.openrouterApiKey = "test-key";
    await readyCard({ kind: "room", name: "Łazienka 1.04", refresh: true });

    expect(readChecklistValue).toHaveBeenCalled();
    const list = (await (await app.request(`/api/projects/${projectId}/cards`, { headers: APP })).json()) as Card[];
    expect(list.map((card) => card.name)).toEqual(["Łazienka 1.04"]);
  });

  it("marks a card as failed when the model keeps failing, and a new request tries again", async () => {
    config.openrouterApiKey = "test-key";
    readChecklistValue.mockRejectedValue(new Error("OpenRouter 402"));

    const failed = await readyCard({ kind: "room", name: "Kuchnia" });
    expect(failed.status).toBe("error");

    readChecklistValue.mockResolvedValue(null);
    expect((await readyCard({ kind: "room", name: "Kuchnia" })).status).toBe("ready");
  });

  it("keeps cards inside their firm", async () => {
    const card = await readyCard({ kind: "room", name: "Łazienka 1.04" }, ADMIN);
    const otherFirm = await createTenant("Inna firma");
    await createUser("obcy@example.com", "owner", undefined, otherFirm);
    const stranger = await login("obcy@example.com");

    expect((await app.request(`/api/cards/${card.id}`, { headers: stranger })).status).toBe(404);
    expect((await app.request(`/api/projects/${projectId}/cards`, { headers: stranger })).status).toBe(404);
    expect((await app.request(`/api/cards/${card.id}`, { method: "DELETE", headers: stranger })).status).toBe(404);
    const [row] = await sql<{ tenantId: string }[]>`select tenant_id as "tenantId" from element_cards where id = ${card.id}`;
    const [project] = await sql<{ tenantId: string }[]>`select tenant_id as "tenantId" from projects where id = ${projectId}`;
    expect(row!.tenantId).toBe(project!.tenantId);
  });
});
