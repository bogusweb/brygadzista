import { access } from "node:fs/promises";
import { config } from "./config.js";
import { sql } from "./db.js";
import { pdfPageCount, pdfPageText, pdfRenderPage } from "./pdf.js";
import { documentPdf, pageImage, pageImagePrefix } from "./storage.js";
import { embed, indexPage, type PageIndex } from "./llm.js";

const POLL_MS = 3000;

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const buildSearchText = (parts: { title?: string; summary?: string; raw: string; facts: { label: string; value: string }[]; keywords: string[] }) =>
  [parts.title, parts.summary, parts.facts.map((f) => `${f.label}: ${f.value}`).join("\n"), parts.keywords.join(" "), parts.raw]
    .filter(Boolean)
    .join("\n");

const CHUNK_CHARS = 2000;

const chunkText = (text: string) => {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS) chunks.push(text.slice(start, start + CHUNK_CHARS));
  return chunks;
};

const storeChunks = async (pageId: string, projectId: string, pageNo: number, index: PageIndex, raw: string) => {
  const header = `Strona ${pageNo}: ${index.title}`;
  const contents = [
    `${header}\n${index.summary}\n${index.facts.map((f) => `${f.label}: ${f.value}`).join("\n")}`,
    ...chunkText(raw.replace(/[ \t]+/g, " ")).map((part) => `${header}\n${part}`),
  ];
  const vectors = await embed(contents);
  await sql.begin(async (tx) => {
    await tx`delete from chunks where page_id = ${pageId}`;
    for (const [i, content] of contents.entries()) {
      await tx`insert into chunks (page_id, project_id, content, embedding)
        values (${pageId}, ${projectId}, ${content}, ${`[${vectors[i]!.join(",")}]`}::vector)`;
    }
  });
};

const indexOnePage = async (doc: { id: string; project_id: string }, pageNo: number) => {
  const pdf = documentPdf(doc.id);
  const image = (await exists(pageImage(doc.id, pageNo)))
    ? pageImage(doc.id, pageNo)
    : await pdfRenderPage(pdf, pageNo, pageImagePrefix(doc.id, pageNo));
  const raw = await pdfPageText(pdf, pageNo);

  // Without an API key the page is still searchable by its PDF text; vision indexing runs on the next reindex.
  const index = config.openrouterApiKey ? await indexPage(image, raw, pageNo) : null;
  const facts = index?.facts ?? [];
  const keywords = index?.keywords ?? [];

  const [page] = await sql<{ id: string }[]>`
    update pages set
      kind = ${index?.kind ?? null},
      title = ${index?.title ?? null},
      raw_text = ${raw},
      summary = ${index?.summary ?? null},
      facts = ${sql.json(facts)},
      keywords = ${keywords},
      search_text = ${buildSearchText({ title: index?.title, summary: index?.summary, raw, facts, keywords })},
      indexed = ${index !== null}
    where document_id = ${doc.id} and page_no = ${pageNo}
    returning id`;
  if (index && page) await storeChunks(page.id, doc.project_id, pageNo, index, raw);
  await sql`update documents set indexed_pages = (select count(*) from pages where document_id = ${doc.id} and search_text <> '') where id = ${doc.id}`;
};

const recordPageFailure = async (documentId: string, pageNo: number, error: unknown) => {
  console.error(`ingest: document ${documentId} page ${pageNo} failed`, error);
  await sql`update pages set error = ${String(error)}, attempts = attempts + 1 where document_id = ${documentId} and page_no = ${pageNo}`;
};

const describeFailedPages = (pageNos: number[]) =>
  `Nie udało się zindeksować ${pageNos.length} ${pageNos.length === 1 ? "strony" : "stron"}: ${pageNos.slice(0, 20).join(", ")}` +
  `${pageNos.length > 20 ? ", …" : ""}. Ponowne indeksowanie spróbuje jeszcze raz.`;

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
  const workers = Array.from({ length: Math.max(1, config.indexConcurrency) }, async () => {
    for (let pageNo = queue.shift(); pageNo !== undefined; pageNo = queue.shift()) {
      try {
        await indexOnePage(doc, pageNo);
        consecutiveFailures = 0;
        await sql`update pages set error = null where document_id = ${doc.id} and page_no = ${pageNo} and error is not null`;
      } catch (error) {
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
  if (fatal) throw fatal;

  const failed = await sql<{ page_no: number }[]>`
    select page_no from pages where document_id = ${doc.id} and error is not null order by page_no`;
  const error = failed.length ? describeFailedPages(failed.map((row) => row.page_no)) : null;
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
    console.log(`ingest: document ${doc.id} ready`);
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
