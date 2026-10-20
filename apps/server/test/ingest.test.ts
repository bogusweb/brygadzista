import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { app } from "../src/app.js";
import { processNextDocument, requeueInterrupted, titleFromText } from "../src/ingest.js";
import { HttpError } from "../src/retry.js";
import { ADMIN, axisVector, createDocument, createProject, insertPage, makePdf, resetDatabase, writeDocumentPdf } from "./helpers.js";

const { embedImage, embed } = vi.hoisted(() => ({
  embedImage: vi.fn<(imagePath: string) => Promise<number[]>>(),
  embed: vi.fn<(texts: string[]) => Promise<number[][]>>(),
}));
vi.mock("../src/llm.js", () => ({ embedImage, embed }));

// Page images are stored as page-0001.jpg and so on.
const pageOf = (imagePath: string) => Number(/(\d+)\.jpg$/.exec(imagePath)![1]);

const PAGES = ["Opis techniczny hali", "Rzut przyziemia", "Detal ocieplenia sciany", "Zestawienie stolarki"];

const pageRows = (documentId: string) =>
  sql<{ page_no: number; indexed: boolean; title: string | null; raw_text: string }[]>`
    select page_no, indexed, title, raw_text from pages where document_id = ${documentId} order by page_no`;

let projectId: string;

beforeEach(async () => {
  await resetDatabase();
  config.openrouterApiKey = "";
  embedImage.mockReset();
  embed.mockReset();
  embedImage.mockResolvedValue(axisVector(0));
  embed.mockImplementation(async (texts) => texts.map((_, i) => axisVector(i)));
  config.maxConsecutivePageFailures = 5;
  projectId = await createProject();
});

afterAll(async () => {
  config.openrouterApiKey = "";
  await sql.end();
});

describe("ingest", () => {
  it("extracts text from every page without an API key and leaves embeddings for later", async () => {
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));

    expect(await processNextDocument()).toBe(true);

    const [doc] = await sql`select status, page_count, indexed_pages, error from documents where id = ${documentId}`;
    expect(doc).toMatchObject({ status: "ready", page_count: 4, indexed_pages: 4 });
    expect(doc!.error).toContain("OPENROUTER_API_KEY");
    const pages = await pageRows(documentId);
    expect(pages.map((page) => page.raw_text)).toEqual(PAGES);
    expect(pages.every((page) => !page.indexed)).toBe(true);
    expect(embedImage).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("embeds the text and the image of every page and titles the page with its first line", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));

    await processNextDocument();

    const pages = await pageRows(documentId);
    expect(pages.every((page) => page.indexed)).toBe(true);
    expect(pages[2]!.title).toBe("Detal ocieplenia sciany");
    expect(embedImage).toHaveBeenCalledTimes(4);
    const chunks = await sql<{ content: string }[]>`select content from chunks where project_id = ${projectId} order by content`;
    expect(chunks).toHaveLength(8);
    expect(chunks.filter((chunk) => chunk.content.includes("[obraz strony]"))).toHaveLength(4);
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

    expect(embedImage.mock.calls.map(([image]) => pageOf(image)).sort()).toEqual([3, 4]);
    const pages = await pageRows(documentId);
    expect(pages.map((page) => page.title)).toEqual(["Gotowa 1", "Gotowa 2", "Detal ocieplenia sciany", "Zestawienie stolarki"]);
    const [doc] = await sql`select status, indexed_pages from documents where id = ${documentId}`;
    expect(doc).toEqual({ status: "ready", indexed_pages: 4 });
  });

  it("skips a page that keeps failing, finishes the rest, and a later run retries only that page", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));
    embedImage.mockImplementation(async (image) => {
      if (pageOf(image) === 2) throw new Error("OpenRouter 503");
      return axisVector(0);
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

    embedImage.mockClear();
    embedImage.mockResolvedValue(axisVector(0));
    await sql`update documents set status = 'queued' where id = ${documentId}`;
    await processNextDocument();

    expect(embedImage.mock.calls.map(([image]) => pageOf(image))).toEqual([2]);
    const [retried] = await sql`select status, error from documents where id = ${documentId}`;
    expect(retried).toEqual({ status: "ready", error: null });
    const [fixed] = await sql`select indexed, error from pages where document_id = ${documentId} and page_no = 2`;
    expect(fixed).toEqual({ indexed: true, error: null });
  });

  it("stops the document after several failures in a row, because then the problem is not one page", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(Array.from({ length: 20 }, (_, i) => `Strona ${i + 1}`)));
    embedImage.mockRejectedValue(new Error("OpenRouter 401: zly klucz"));

    await processNextDocument();

    const [doc] = await sql`select status, error from documents where id = ${documentId}`;
    expect(doc).toEqual({ status: "error", error: "Error: OpenRouter 401: zly klucz" });
    // Workers already busy finish their page, nothing else is started.
    expect(embedImage.mock.calls.length).toBeLessThan(config.maxConsecutivePageFailures + config.indexConcurrency);
  });

  it("does nothing when the queue is empty", async () => {
    expect(await processNextDocument()).toBe(false);
  });
});

describe("page title from PDF text", () => {
  it("prefers a heading in capitals near the top over a sentence cut mid-way", () => {
    const raw = "d) liczba kondygnacji – dwie kondygnacje nadziemne (parter i piętro), budynek\nniepodpiwniczony,\n\nIV.   OGÓLNA CHARAKTERYSTYKA BUDYNKU\nPrzedmiotem opracowania jest";
    expect(titleFromText(raw)).toBe("IV. OGÓLNA CHARAKTERYSTYKA BUDYNKU");
  });

  it("falls back to the first line, and to nothing for a page without text", () => {
    expect(titleFromText("\n  Rzut   przyziemia\nskala 1:100")).toBe("Rzut przyziemia");
    expect(titleFromText(" \n")).toBeNull();
  });
});

describe("ingest of a very large PDF", () => {
  it("indexes 300 pages with progress tracking and does not stop on a few bad pages", { timeout: 180_000 }, async () => {
    config.openrouterApiKey = "test-key";
    const pageCount = 300;
    const failing = new Set([77, 210]);
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(Array.from({ length: pageCount }, (_, i) => `Arkusz ${i + 1} sciana fundamentowa`)));
    embedImage.mockImplementation(async (image) => {
      if (failing.has(pageOf(image))) throw new Error("OpenRouter 429");
      return axisVector(0);
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
    expect(embedImage).toHaveBeenCalledTimes(pageCount);
  });
});

describe("pausing and resuming", () => {
  const documentStatus = async (documentId: string) =>
    (await sql<{ status: string; error: string | null }[]>`select status, error from documents where id = ${documentId}`)[0]!;

  const resume = (documentId: string) => app.request(`/api/documents/${documentId}/resume`, { method: "POST", headers: ADMIN });

  it("pauses on an exhausted OpenRouter budget and resumes without embedding finished pages again", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));
    embedImage.mockImplementation(async (imagePath) => {
      if (pageOf(imagePath) === 3) throw new HttpError("Insufficient credits", 402);
      return axisVector(0);
    });

    await processNextDocument();

    const paused = await documentStatus(documentId);
    expect(paused.status).toBe("paused");
    expect(paused.error).toContain("402");
    const [page3] = await sql`select indexed, error, attempts from pages where document_id = ${documentId} and page_no = 3`;
    expect(page3).toMatchObject({ indexed: false, error: null, attempts: 0 });
    const done = (await pageRows(documentId)).filter((page) => page.indexed).map((page) => page.page_no);
    expect(done).toEqual(expect.arrayContaining([1, 2]));

    embedImage.mockReset();
    embedImage.mockResolvedValue(axisVector(0));
    expect((await resume(documentId)).status).toBe(200);
    await processNextDocument();

    expect(await documentStatus(documentId)).toMatchObject({ status: "ready", error: null });
    expect((await pageRows(documentId)).every((page) => page.indexed)).toBe(true);
    const resumedPages = embedImage.mock.calls.map(([imagePath]) => pageOf(imagePath)).sort();
    expect(resumedPages).toEqual([1, 2, 3, 4].filter((pageNo) => !done.includes(pageNo)));
  });

  it("pauses when OpenRouter still rate-limits after the retries", async () => {
    config.openrouterApiKey = "test-key";
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(PAGES));
    embedImage.mockRejectedValue(new HttpError("Too many requests", 429));

    await processNextDocument();

    const status = await documentStatus(documentId);
    expect(status.status).toBe("paused");
    expect(status.error).toContain("429");
    expect(await sql`select 1 from pages where document_id = ${documentId} and error is not null`).toHaveLength(0);
  });

  it("stays paused across a restart and refuses to resume a document that is still indexing", async () => {
    const pausedId = await createDocument(projectId, "paused");
    const processingId = await createDocument(projectId, "processing");

    await requeueInterrupted();

    expect((await documentStatus(pausedId)).status).toBe("paused");
    expect((await resume(processingId)).status).toBe(409);
  });
});
