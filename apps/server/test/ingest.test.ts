import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { processNextDocument, requeueInterrupted } from "../src/ingest.js";
import type { PageIndex } from "../src/llm.js";
import { axisVector, createDocument, createProject, insertPage, makePdf, resetDatabase, writeDocumentPdf } from "./helpers.js";

const { indexPage, embed } = vi.hoisted(() => ({
  indexPage: vi.fn<(imagePath: string, rawText: string, pageNo: number) => Promise<PageIndex>>(),
  embed: vi.fn<(texts: string[]) => Promise<number[][]>>(),
}));
vi.mock("../src/llm.js", () => ({ indexPage, embed }));

const PAGES = ["Opis techniczny hali", "Rzut przyziemia", "Detal ocieplenia sciany", "Zestawienie stolarki"];

const pageRows = (documentId: string) =>
  sql<{ page_no: number; indexed: boolean; title: string | null; raw_text: string }[]>`
    select page_no, indexed, title, raw_text from pages where document_id = ${documentId} order by page_no`;

let projectId: string;

beforeEach(async () => {
  await resetDatabase();
  config.openrouterApiKey = "";
  indexPage.mockReset();
  embed.mockReset();
  indexPage.mockImplementation(async (_image, rawText, pageNo) => ({
    title: `Strona ${pageNo}`,
    kind: "opis",
    summary: rawText,
    facts: [{ label: "Grubość", value: "15 cm" }],
    keywords: ["ocieplenie"],
  }));
  embed.mockImplementation(async (texts) => texts.map((_, i) => axisVector(i)));
  projectId = await createProject();
});

afterAll(async () => {
  config.openrouterApiKey = "";
  await sql.end();
});

describe("ingest", () => {
  it("extracts text from every page without an API key and leaves vision indexing for later", async () => {
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));

    expect(await processNextDocument()).toBe(true);

    const [doc] = await sql`select status, page_count, indexed_pages from documents where id = ${documentId}`;
    expect(doc).toEqual({ status: "ready", page_count: 4, indexed_pages: 4 });
    const pages = await pageRows(documentId);
    expect(pages.map((page) => page.raw_text)).toEqual(PAGES);
    expect(pages.every((page) => !page.indexed)).toBe(true);
    expect(indexPage).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("indexes pages with the model and stores their chunks", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));

    await processNextDocument();

    const pages = await pageRows(documentId);
    expect(pages.every((page) => page.indexed)).toBe(true);
    expect(pages[2]!.title).toBe("Strona 3");
    expect(indexPage).toHaveBeenCalledTimes(4);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from chunks where project_id = ${projectId}`;
    expect(count).toBe(8);
  });

  it("resumes a document interrupted by a restart without redoing finished pages", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId, "processing");
    await writeDocumentPdf(documentId, makePdf(PAGES));
    await insertPage(projectId, documentId, 1, { title: "Gotowa 1", searchText: "Opis techniczny hali", indexed: true });
    await insertPage(projectId, documentId, 2, { title: "Gotowa 2", searchText: "Rzut przyziemia", indexed: true });

    expect(await processNextDocument()).toBe(false);
    await requeueInterrupted();
    expect(await processNextDocument()).toBe(true);

    expect(indexPage.mock.calls.map(([, , pageNo]) => pageNo).sort()).toEqual([3, 4]);
    const pages = await pageRows(documentId);
    expect(pages.map((page) => page.title)).toEqual(["Gotowa 1", "Gotowa 2", "Strona 3", "Strona 4"]);
    const [doc] = await sql`select status, indexed_pages from documents where id = ${documentId}`;
    expect(doc).toEqual({ status: "ready", indexed_pages: 4 });
  });

  it("marks the document as failed when the model errors, and a later run picks up where it stopped", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));
    indexPage.mockRejectedValueOnce(new Error("OpenRouter 503"));

    await processNextDocument();

    const [failed] = await sql`select status, error from documents where id = ${documentId}`;
    expect(failed).toEqual({ status: "error", error: "Error: OpenRouter 503" });
    const doneBeforeRetry = (await pageRows(documentId)).filter((page) => page.indexed).length;
    expect(doneBeforeRetry).toBeLessThan(PAGES.length);

    await sql`update documents set status = 'queued' where id = ${documentId}`;
    indexPage.mockClear();
    await processNextDocument();

    const [doc] = await sql`select status from documents where id = ${documentId}`;
    expect(doc).toEqual({ status: "ready" });
    expect((await pageRows(documentId)).every((page) => page.indexed)).toBe(true);
    expect(indexPage).toHaveBeenCalledTimes(PAGES.length - doneBeforeRetry);
  });

  it("does nothing when the queue is empty", async () => {
    expect(await processNextDocument()).toBe(false);
  });
});
