import { access } from "node:fs/promises";
import type { TransactionSql } from "postgres";
import { chunkPage } from "./chunking.js";
import { CODES_VERSION, extractCodes } from "./codes.js";
import { config } from "./config.js";
import { replacePageFacts, sql, withTenant } from "./db.js";
import { buildingEmbeddingSet, pagesMissingFrom, recordSetError, switchToSet, writeEmbeddingSet, type EmbeddingSet } from "./embedding-sets.js";
import { titleFromText } from "./outline.js";
import { saveOutline } from "./project-outline.js";
import { META_VERSION, displayTitle, extractPageMeta } from "./page-meta.js";
import { pdfPageCount, pdfPageText, pdfRenderPage } from "./pdf.js";
import { documentPdf, pageImage, pageImagePrefix } from "./storage.js";
import { embed, embedImage } from "./llm.js";
import { statusOf } from "./retry.js";

export { titleFromText };

const POLL_MS = 3000;

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const IMAGE_CHUNK_TEXT_CHARS = 500;

type Chunk = { content: string; vector: number[] };

// One chunk per text fragment plus one for the page image, so a drawing without a text layer is still found.
const embedPage = async (pageNo: number, title: string | null, raw: string, image: string, target: EmbeddingSet): Promise<Chunk[]> => {
  const header = title ? `Strona ${pageNo}: ${title}` : `Strona ${pageNo}`;
  const textChunks = chunkPage(raw).map((part) => `${header}\n${part}`);
  const imageChunk = `${header}\n[obraz strony]\n${raw.slice(0, IMAGE_CHUNK_TEXT_CHARS)}`;
  const [textVectors, imageVector] = await Promise.all([embed(textChunks, target), embedImage(image, target)]);
  return [...textChunks.map((content, i) => ({ content, vector: textVectors[i]! })), { content: imageChunk, vector: imageVector }];
};

const imageOf = async (documentId: string, pageNo: number) =>
  (await exists(pageImage(documentId, pageNo)))
    ? pageImage(documentId, pageNo)
    : await pdfRenderPage(documentPdf(documentId), pageNo, pageImagePrefix(documentId, pageNo));

// Vectors of one page in one set, replacing what the page had there; other sets keep theirs, so search on the old
// model is untouched while a new one is built.
const saveChunks = async (tx: TransactionSql, page: { id: string; projectId: string }, target: EmbeddingSet, chunks: Chunk[]) => {
  await tx`delete from chunks where page_id = ${page.id} and embedding_set = ${target.id}`;
  for (const chunk of chunks) {
    await tx`insert into chunks (page_id, project_id, content, embedding, embedding_set)
      values (${page.id}, ${page.projectId}, ${chunk.content}, ${`[${chunk.vector.join(",")}]`}::vector, ${target.id})`;
  }
};

const indexOnePage = async (doc: { id: string; project_id: string; tenant_id: string }, pageNo: number) => {
  const pdf = documentPdf(doc.id);
  const image = await imageOf(doc.id, pageNo);
  const raw = await pdfPageText(pdf, pageNo);
  const meta = extractPageMeta(raw, pageNo);
  const title = displayTitle(meta, titleFromText(raw));
  // A page with no text layer still needs a non-empty search text, or it would count as never indexed.
  const searchText = raw.trim() ? raw : `Strona ${pageNo}`;

  // Without an API key the page is searchable by its PDF text only; embeddings run on the next reindex.
  // Embeddings come first, so a page whose call fails is left untouched and counts as not done.
  const target = config.openrouterApiKey ? await writeEmbeddingSet() : null;
  const chunks = target ? await embedPage(pageNo, title, raw, image, target) : null;

  // The page is written as the document's firm, under the same row level security as a request (#92).
  await withTenant(doc.tenant_id, async (tx) => {
    const [page] = await tx<{ id: string }[]>`
      update pages set
        kind = ${meta.kind},
        title = ${title},
        drawing_no = ${meta.drawingNo},
        scale = ${meta.scale},
        revision = ${meta.revision},
        branch = ${meta.branch},
        level = ${meta.level},
        meta_version = ${META_VERSION},
        raw_text = ${raw},
        summary = null,
        keywords = ${[]},
        search_text = ${searchText},
        codes = ${extractCodes(`${title ?? ""}\n${raw}`)},
        codes_version = ${CODES_VERSION},
        schedule_version = null,
        indexed = ${chunks !== null}
      where document_id = ${doc.id} and page_no = ${pageNo}
      returning id`;
    if (!page) return;
    await replacePageFacts(tx, page.id, doc.project_id, raw);
    if (target && chunks) await saveChunks(tx, { id: page.id, projectId: doc.project_id }, target, chunks);
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

const processDocument = async (doc: { id: string; project_id: string; tenant_id: string }) => {
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
  await saveOutline(doc.id);
  await sql`update documents set status = 'ready', error = ${error} where id = ${doc.id}`;
};

const claimNextDocument = async () => {
  const [doc] = await sql<{ id: string; project_id: string; tenant_id: string }[]>`
    update documents set status = 'processing'
    where id = (select id from documents where status = 'queued' order by created_at limit 1 for update skip locked)
    returning id, project_id, tenant_id`;
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

const REEMBED_BATCH = 4;
// After OpenRouter refuses for credit or rate limits, the re-embed waits this long before trying again.
const REEMBED_PAUSE_MS = 5 * 60_000;

// One step of a model change (#46): a few pages get vectors from the new model, and once every indexed page has them,
// search switches to the new set in one transaction and the old vectors are deleted. Search keeps reading the old set
// until then. A page that fails is marked as not indexed, so resuming its document redoes it with the new model and the
// switch is not held up. Returns whether there was work.
export const reembedNextPages = async () => {
  if (!config.openrouterApiKey) return false;
  const target = await buildingEmbeddingSet();
  if (!target || (target.retryAt && target.retryAt > new Date())) return false;
  const pages = await pagesMissingFrom(target.id, REEMBED_BATCH);
  if (pages.length === 0) {
    if (await switchToSet(target.id)) console.log(`embeddings: search now uses ${target.id}`);
    return true;
  }
  for (const page of pages) {
    try {
      const chunks = await embedPage(page.page_no, page.title, page.raw_text, await imageOf(page.document_id, page.page_no), target);
      await sql.begin((tx) => saveChunks(tx, { id: page.id, projectId: page.project_id }, target, chunks));
    } catch (error) {
      const reason = pauseReason(error);
      if (reason) {
        await recordSetError(target.id, reason, new Date(Date.now() + REEMBED_PAUSE_MS));
        return false;
      }
      console.error(`embeddings: page ${page.id} failed to re-embed`, error);
      await sql`update pages set indexed = false, error = ${String(error)}, attempts = attempts + 1 where id = ${page.id}`;
    }
  }
  if (target.error) await recordSetError(target.id, null, null);
  return true;
};

export const startIngestWorker = async () => {
  await requeueInterrupted();
  const tick = async () => {
    const found = (await processNextDocument()) || (await reembedNextPages().catch((error) => {
      console.error("embeddings: re-embed step failed", error);
      return false;
    }));
    setTimeout(tick, found ? 0 : POLL_MS);
  };
  void tick();
};
