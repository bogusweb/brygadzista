import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { migrate, sql } from "../src/db.js";
import { embeddingSetId } from "../src/embedding-model.js";
import { processNextDocument, reembedNextPages } from "../src/ingest.js";
import { searchPages } from "../src/search.js";
import { ADMIN, axisVector, createDocument, createProject, makePdf, resetDatabase, writeDocumentPdf } from "./helpers.js";

const { embedImage, embed } = vi.hoisted(() => ({
  embedImage: vi.fn<(imagePath: string, target: { model: string }) => Promise<number[]>>(),
  embed: vi.fn<(texts: string[], target: { model: string }) => Promise<number[][]>>(),
}));
vi.mock("../src/llm.js", () => ({ embedImage, embed }));

const OLD_MODEL = config.embeddingModel;
const NEW_MODEL = "test/new-embedding";
const OLD_SET = embeddingSetId({ model: OLD_MODEL, dimensions: config.embeddingDimensions });
const NEW_SET = embeddingSetId({ model: NEW_MODEL, dimensions: config.embeddingDimensions });

// Each model puts the same page in a different place, so a test can tell which vectors a search used: the old model
// points page texts at axis 0, the new one at axis 1, and each embeds questions on its own axis.
const vectorFor = (target: { model: string }) => axisVector(target.model === NEW_MODEL ? 1 : 0);

const setsRows = () => sql`select id, status from embedding_sets order by id`;
const chunkSets = (projectId: string) =>
  sql<{ embedding_set: string; count: number }[]>`
    select embedding_set, count(*)::int from chunks where project_id = ${projectId} group by embedding_set order by embedding_set`;

let projectId: string;

beforeEach(async () => {
  config.embeddingModel = OLD_MODEL;
  await resetDatabase();
  await sql`delete from embedding_sets`;
  await migrate();
  config.openrouterApiKey = "test-key";
  embed.mockReset().mockImplementation(async (texts, target) => texts.map(() => vectorFor(target)));
  embedImage.mockReset().mockImplementation(async (_image, target) => vectorFor(target));
  projectId = await createProject();
  const documentId = await createDocument(projectId);
  await writeDocumentPdf(documentId, makePdf(["Opis techniczny hali", "Detal attyki"]));
  await processNextDocument();
});

afterAll(async () => {
  config.embeddingModel = OLD_MODEL;
  config.openrouterApiKey = "";
  await sql`delete from embedding_sets`;
  await migrate();
  await sql.end();
});

describe("embedding model change (#46)", () => {
  it("tags vectors with the model that made them", async () => {
    expect(await setsRows()).toEqual([{ id: OLD_SET, status: "active" }]);
    expect(await chunkSets(projectId)).toEqual([{ embedding_set: OLD_SET, count: 4 }]);
  });

  it("keeps searching with the old model while the new vectors are built, then switches and drops the old ones", async () => {
    config.embeddingModel = NEW_MODEL;
    await migrate();
    expect(await setsRows()).toEqual([
      { id: OLD_SET, status: "active" },
      { id: NEW_SET, status: "building" },
    ]);

    // Half way: one page has new vectors, search still embeds the question with the old model and finds pages.
    embed.mockClear();
    const firstStep = await reembedNextPages();
    expect(firstStep).toBe(true);
    const during = await searchPages(projectId, "zupełnie inne słowa xyz");
    expect(embed.mock.calls.at(-1)?.[1]).toMatchObject({ model: OLD_MODEL });
    expect(during.length).toBeGreaterThan(0);
    expect(await chunkSets(projectId)).toEqual([
      { embedding_set: OLD_SET, count: 4 },
      { embedding_set: NEW_SET, count: 4 },
    ]);

    // Nothing left to build: the next step switches atomically and removes the old set.
    expect(await reembedNextPages()).toBe(true);
    expect(await setsRows()).toEqual([
      { id: OLD_SET, status: "retired" },
      { id: NEW_SET, status: "active" },
    ]);
    expect(await chunkSets(projectId)).toEqual([{ embedding_set: NEW_SET, count: 4 }]);

    embed.mockClear();
    const after = await searchPages(projectId, "zupełnie inne słowa xyz");
    expect(embed.mock.calls.at(-1)?.[1]).toMatchObject({ model: NEW_MODEL });
    expect(after.length).toBeGreaterThan(0);
    expect(await reembedNextPages()).toBe(false);
  });

  it("indexes new pages with the new model during a change without touching the old vectors", async () => {
    config.embeddingModel = NEW_MODEL;
    await migrate();
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(["Zestawienie stolarki"]));

    await processNextDocument();

    expect(await chunkSets(projectId)).toEqual([
      { embedding_set: OLD_SET, count: 4 },
      { embedding_set: NEW_SET, count: 2 },
    ]);
  });

  it("pauses the change when OpenRouter refuses for credit and keeps the old set", async () => {
    config.embeddingModel = NEW_MODEL;
    await migrate();
    embedImage.mockRejectedValue(Object.assign(new Error("Embedding 402"), { status: 402 }));

    expect(await reembedNextPages()).toBe(false);

    const [set] = await sql`select status, error, retry_at > now() as later from embedding_sets where id = ${NEW_SET}`;
    expect(set).toMatchObject({ status: "building", later: true });
    expect(set!.error).toContain("402");
    expect(await reembedNextPages()).toBe(false);
  });

  it("drops a half built set when the configuration goes back to the active model", async () => {
    config.embeddingModel = NEW_MODEL;
    await migrate();
    await reembedNextPages();
    config.embeddingModel = OLD_MODEL;

    await migrate();

    expect(await setsRows()).toEqual([
      { id: OLD_SET, status: "active" },
      { id: NEW_SET, status: "retired" },
    ]);
    expect(await chunkSets(projectId)).toEqual([{ embedding_set: OLD_SET, count: 4 }]);
  });

  it("shows the active model and the progress of a change on the dashboard", async () => {
    config.embeddingModel = NEW_MODEL;
    await migrate();
    embedImage.mockImplementation(async (image, target) => {
      if (target.model === NEW_MODEL && image.endsWith("0002.jpg")) throw new Error("zła strona");
      return vectorFor(target);
    });

    await reembedNextPages();
    const response = await app.request("/api/admin/embeddings", { headers: ADMIN });

    expect(await response.json()).toEqual({
      active: { model: OLD_MODEL, dimensions: config.embeddingDimensions },
      building: { model: NEW_MODEL, dimensions: config.embeddingDimensions, error: null, done: 1, total: 1 },
    });
  });
});
