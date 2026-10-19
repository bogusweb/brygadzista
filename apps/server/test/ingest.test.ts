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
  config.maxConsecutivePageFailures = 5;
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

  it("skips a page that keeps failing, finishes the rest, and a later run retries only that page", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));
    indexPage.mockImplementation(async (_image, rawText, pageNo) => {
      if (pageNo === 2) throw new Error("OpenRouter 503");
      return { title: `Strona ${pageNo}`, kind: "opis", summary: rawText, facts: [], keywords: [] };
    });

    await processNextDocument();

    const [doc] = await sql`select status, error, run_total, run_done from documents where id = ${documentId}`;
    expect(doc).toEqual({
      status: "ready",
      error: "Nie udało się zindeksować 1 strony: 2. Ponowne indeksowanie spróbuje jeszcze raz.",
      run_total: 4,
      run_done: 4,
    });
    const [page2] = await sql`select indexed, error, attempts from pages where document_id = ${documentId} and page_no = 2`;
    expect(page2).toEqual({ indexed: false, error: "Error: OpenRouter 503", attempts: 1 });
    expect((await pageRows(documentId)).filter((page) => page.indexed).map((page) => page.page_no)).toEqual([1, 3, 4]);

    indexPage.mockClear();
    indexPage.mockImplementation(async (_image, rawText, pageNo) => ({ title: `Strona ${pageNo}`, kind: "opis", summary: rawText, facts: [], keywords: [] }));
    await sql`update documents set status = 'queued' where id = ${documentId}`;
    await processNextDocument();

    expect(indexPage.mock.calls.map(([, , pageNo]) => pageNo)).toEqual([2]);
    const [retried] = await sql`select status, error from documents where id = ${documentId}`;
    expect(retried).toEqual({ status: "ready", error: null });
    const [fixed] = await sql`select indexed, error from pages where document_id = ${documentId} and page_no = 2`;
    expect(fixed).toEqual({ indexed: true, error: null });
  });

  it("stops the document after several failures in a row, because then the problem is not one page", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(Array.from({ length: 20 }, (_, i) => `Strona ${i + 1}`)));
    indexPage.mockRejectedValue(new Error("OpenRouter 401: zly klucz"));

    await processNextDocument();

    const [doc] = await sql`select status, error from documents where id = ${documentId}`;
    expect(doc).toEqual({ status: "error", error: "Error: OpenRouter 401: zly klucz" });
    // Workers already busy finish their page, nothing else is started.
    expect(indexPage.mock.calls.length).toBeLessThan(config.maxConsecutivePageFailures + config.indexConcurrency);
  });

  it("does nothing when the queue is empty", async () => {
    expect(await processNextDocument()).toBe(false);
  });
});

describe("ingest of a very large PDF", () => {
  it("indexes 300 pages with progress tracking and does not stop on a few bad pages", { timeout: 180_000 }, async () => {
    config.openrouterApiKey = "test-key";
    const pageCount = 300;
    const failing = new Set([77, 210]);
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(Array.from({ length: pageCount }, (_, i) => `Arkusz ${i + 1} sciana fundamentowa`)));
    indexPage.mockImplementation(async (_image, rawText, pageNo) => {
      if (failing.has(pageNo)) throw new Error("OpenRouter 429");
      return { title: `Arkusz ${pageNo}`, kind: "rysunek", summary: rawText, facts: [], keywords: [] };
    });

    const started = Date.now();
    await processNextDocument();
    console.log(`300 pages: ${((Date.now() - started) / 1000).toFixed(1)} s`);

    const [doc] = await sql`select status, page_count, indexed_pages, run_total, run_done, error from documents where id = ${documentId}`;
    expect(doc).toMatchObject({ status: "ready", page_count: pageCount, indexed_pages: pageCount - failing.size, run_total: pageCount, run_done: pageCount });
    expect(doc!.error).toContain("2 stron: 77, 210");
    const [{ indexed }] = await sql<{ indexed: number }[]>`
      select count(*)::int as indexed from pages where document_id = ${documentId} and indexed`;
    expect(indexed).toBe(pageCount - failing.size);
    expect(indexPage).toHaveBeenCalledTimes(pageCount);
  });
});
