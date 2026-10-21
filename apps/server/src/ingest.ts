import { access } from "node:fs/promises";
import { CODES_VERSION, extractCodes } from "./codes.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { pdfPageCount, pdfPageText, pdfRenderPage } from "./pdf.js";
import { documentPdf, pageImage, pageImagePrefix } from "./storage.js";
import { embed, embedImage } from "./llm.js";
import { statusOf } from "./retry.js";

const POLL_MS = 3000;

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const TITLE_CHARS = 120;

const HEADING_SEARCH_LINES = 30;

// Without a reading model the title comes from the PDF text: the first heading in capitals near the top
// (e.g. "IV. OGÓLNA CHARAKTERYSTYKA BUDYNKU"), else the first line.
const isHeading = (line: string) => {
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toLocaleUpperCase("pl") && line.length <= TITLE_CHARS;
};

export const titleFromText = (raw: string) => {
  const lines = raw.split("\n").map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  const line = lines.slice(0, HEADING_SEARCH_LINES).find(isHeading) ?? lines[0];
  return line ? line.slice(0, TITLE_CHARS) : null;
};

const CHUNK_CHARS = 2000;

const chunkText = (text: string) => {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS) chunks.push(text.slice(start, start + CHUNK_CHARS));
  return chunks;
};

const IMAGE_CHUNK_TEXT_CHARS = 500;

type Chunk = { content: string; vector: number[] };

// One chunk per text fragment plus one for the page image, so a drawing without a text layer is still found.
const embedPage = async (pageNo: number, title: string | null, raw: string, image: string): Promise<Chunk[]> => {
  const header = title ? `Strona ${pageNo}: ${title}` : `Strona ${pageNo}`;
  const textChunks = chunkText(raw.replace(/[ \t]+/g, " ")).map((part) => `${header}\n${part}`);
  const imageChunk = `${header}\n[obraz strony]\n${raw.slice(0, IMAGE_CHUNK_TEXT_CHARS)}`;
  const [textVectors, imageVector] = await Promise.all([embed(textChunks), embedImage(image)]);
  return [...textChunks.map((content, i) => ({ content, vector: textVectors[i]! })), { content: imageChunk, vector: imageVector }];
};

const indexOnePage = async (doc: { id: string; project_id: string }, pageNo: number) => {
  const pdf = documentPdf(doc.id);
  const image = (await exists(pageImage(doc.id, pageNo)))
    ? pageImage(doc.id, pageNo)
    : await pdfRenderPage(pdf, pageNo, pageImagePrefix(doc.id, pageNo));
  const raw = await pdfPageText(pdf, pageNo);
  const title = titleFromText(raw);
  // A page with no text layer still needs a non-empty search text, or it would count as never indexed.
  const searchText = raw.trim() ? raw : `Strona ${pageNo}`;

  // Without an API key the page is searchable by its PDF text only; embeddings run on the next reindex.
  // Embeddings come first, so a page whose call fails is left untouched and counts as not done.
  const chunks = config.openrouterApiKey ? await embedPage(pageNo, title, raw, image) : null;

  await sql.begin(async (tx) => {
    const [page] = await tx<{ id: string }[]>`
      update pages set
        kind = null,
        title = ${title},
        raw_text = ${raw},
        summary = null,
        facts = ${tx.json([])},
        keywords = ${[]},
        search_text = ${searchText},
        codes = ${extractCodes(`${title ?? ""}\n${raw}`)},
        codes_version = ${CODES_VERSION},
        indexed = ${chunks !== null}
      where document_id = ${doc.id} and page_no = ${pageNo}
      returning id`;
    if (!page || !chunks) return;
    await tx`delete from chunks where page_id = ${page.id}`;
    for (const chunk of chunks) {
      await tx`insert into chunks (page_id, project_id, content, embedding)
        values (${page.id}, ${doc.project_id}, ${chunk.content}, ${`[${chunk.vector.join(",")}]`}::vector)`;
    }
  });
  await sql`update documents set indexed_pages = (select count(*) from pages where document_id = ${doc.id} and search_text <> '') where id = ${doc.id}`;
};

const recordPageFailure = async (documentId: string, pageNo: number, error: unknown) => {
  console.error(`ingest: document ${documentId} page ${pageNo} failed`, error);
  await sql`update pages set error = ${String(error)}, attempts = attempts + 1 where document_id = ${documentId} and page_no = ${pageNo}`;
};

const describeFailedPages = (pageNos: number[]) =>
  `Nie udało się zindeksować ${pageNos.length} ${pageNos.length === 1 ? "strony" : "stron"}: ${pageNos.slice(0, 20).join(", ")}` +
  `${pageNos.length > 20 ? ", …" : ""}. Ponowne indeksowanie spróbuje jeszcze raz.`;

// Without a key the document still becomes searchable by its text, but the dashboard must not present that as done.
const NO_API_KEY_MESSAGE =
  "Brak klucza OPENROUTER_API_KEY na serwerze: strony mają tylko tekst z PDF, bez wyszukiwania semantycznego i obrazów. Ustaw klucz i zindeksuj ponownie.";

// Out of credit on OpenRouter (402) or still rate limited after the call's own retries (429): no other page would get
// through either, so the document pauses with a readable message instead of failing, and resuming picks up only
// the pages that are not done.
const pauseReason = (error: unknown) => {
  const status = statusOf(error);
  if (status === 402) {
    return "Wstrzymano: na koncie OpenRouter skończyły się środki albo klucz przekroczył swój limit (402). " +
      "Zwiększ limit i kliknij „Wznów indeksowanie”; gotowe strony nie będą liczone ponownie.";
  }
  if (status === 429) {
    return "Wstrzymano: OpenRouter odrzuca zapytania z powodu limitu (429). " +
      "Odczekaj chwilę i kliknij „Wznów indeksowanie”; gotowe strony nie będą liczone ponownie.";
  }
  return undefined;
};

const processDocument = async (doc: { id: string; project_id: string }) => {
  const pageCount = await pdfPageCount(documentPdf(doc.id));
  await sql`update documents set page_count = ${pageCount}, status = 'processing', error = null where id = ${doc.id}`;
  await sql`
    insert into pages (document_id, project_id, page_no)
    select ${doc.id}, ${doc.project_id}, n from generate_series(1, ${pageCount}::int) as n
    on conflict do nothing`;

  const pending = await sql<{ page_no: number }[]>`
    select page_no from pages where document_id = ${doc.id} and (search_text = '' or not indexed) order by page_no`;
  const queue = pending.map((row) => row.page_no);
  await sql`update documents set started_at = now(), run_total = ${queue.length}, run_done = 0 where id = ${doc.id}`;

  // A page that still fails after the model call's own retries is recorded and skipped, so one bad sheet
  // does not hold up the rest. Several failures in a row mean something bigger (key, outage): then the
  // other workers stop taking pages and the error is raised once they finish, so nothing keeps indexing
  // a document that is already marked as failed.
  let consecutiveFailures = 0;
  let fatal: unknown;
  let paused: string | undefined;
  const workers = Array.from({ length: Math.max(1, config.indexConcurrency) }, async () => {
    for (let pageNo = queue.shift(); pageNo !== undefined; pageNo = queue.shift()) {
      try {
        await indexOnePage(doc, pageNo);
        consecutiveFailures = 0;
        await sql`update pages set error = null where document_id = ${doc.id} and page_no = ${pageNo} and error is not null`;
      } catch (error) {
        const reason = pauseReason(error);
        if (reason) {
          paused ??= reason;
          queue.length = 0;
          continue;
        }
        await recordPageFailure(doc.id, pageNo, error);
        if (++consecutiveFailures >= config.maxConsecutivePageFailures) {
          queue.length = 0;
          fatal ??= error;
        }
      }
      await sql`update documents set run_done = run_done + 1 where id = ${doc.id}`;
    }
  });
  await Promise.all(workers);
  if (paused) {
    console.warn(`ingest: document ${doc.id} paused: ${paused}`);
    await sql`update documents set status = 'paused', error = ${paused} where id = ${doc.id}`;
    return;
  }
  if (fatal) throw fatal;

  const failed = await sql<{ page_no: number }[]>`
    select page_no from pages where document_id = ${doc.id} and error is not null order by page_no`;
  const error = failed.length
    ? describeFailedPages(failed.map((row) => row.page_no))
    : config.openrouterApiKey
      ? null
      : NO_API_KEY_MESSAGE;
  await sql`update documents set status = 'ready', error = ${error} where id = ${doc.id}`;
};

const claimNextDocument = async () => {
  const [doc] = await sql<{ id: string; project_id: string }[]>`
    update documents set status = 'processing'
    where id = (select id from documents where status = 'queued' order by created_at limit 1 for update skip locked)
    returning id, project_id`;
  return doc;
};

// Documents interrupted by a restart go back to the queue; finished pages are skipped.
export const requeueInterrupted = () => sql`update documents set status = 'queued' where status = 'processing'`;

// Claims and processes one queued document. Returns whether there was one.
export const processNextDocument = async () => {
  const doc = await claimNextDocument().catch((error) => {
    console.error("ingest: claim failed", error);
    return undefined;
  });
  if (!doc) return false;
  try {
    await processDocument(doc);
    console.log(`ingest: document ${doc.id} done`);
  } catch (error) {
    console.error(`ingest: document ${doc.id} failed`, error);
    await sql`update documents set status = 'error', error = ${String(error)} where id = ${doc.id}`;
  }
  return true;
};

export const startIngestWorker = async () => {
  await requeueInterrupted();
  const tick = async () => {
    const found = await processNextDocument();
    setTimeout(tick, found ? 0 : POLL_MS);
  };
  void tick();
};
