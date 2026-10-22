import { sql } from "./db.js";
import { buildOutline, OUTLINE_VERSION, type DocumentOutline } from "./outline.js";

// Builds the outline of a document from the stored text of its pages; cheap, so it also runs for documents indexed
// before outlines existed or with an older version of the builder.
export const saveOutline = async (documentId: string) => {
  const pages = await sql<{ pageNo: number; text: string }[]>`
    select page_no as "pageNo", raw_text as text from pages where document_id = ${documentId} order by page_no`;
  const outline = buildOutline(pages);
  await sql`update documents set outline = ${sql.json(outline)} where id = ${documentId}`;
  return outline;
};

export type ProjectDocumentOutline = {
  documentId: string;
  filename: string;
  pageCount: number;
  status: string;
  outline: DocumentOutline | null;
};

// Documents still being indexed have no outline yet; it is built once their pages are read.
export const projectOutline = async (projectId: string): Promise<ProjectDocumentOutline[]> => {
  const documents = await sql<(Omit<ProjectDocumentOutline, "outline"> & { outline: DocumentOutline | null })[]>`
    select id as "documentId", filename, page_count as "pageCount", status, outline
    from documents where project_id = ${projectId} order by created_at`;
  return Promise.all(
    documents.map(async (document) => {
      if (document.status !== "ready" && document.status !== "paused") return { ...document, outline: null };
      if (document.outline?.version === OUTLINE_VERSION) return document;
      return { ...document, outline: await saveOutline(document.documentId) };
    }),
  );
};

export const MAX_PAGES_PER_CALL = 5;
const PAGE_TEXT_CHARS = 6000;

export type PageContent = {
  pageNo: number;
  title: string | null;
  kind: string | null;
  summary: string | null;
  text: string;
  truncated?: true;
};

// Text and summary of a run of pages, at most MAX_PAGES_PER_CALL at a time so one call cannot flood the model.
export const readPages = async (projectId: string, documentId: string, from: number, to: number) => {
  const last = Math.min(to, from + MAX_PAGES_PER_CALL - 1);
  const rows = await sql<{ pageNo: number; title: string | null; kind: string | null; summary: string | null; text: string }[]>`
    select page_no as "pageNo", title, kind, summary, raw_text as text from pages
    where project_id = ${projectId} and document_id = ${documentId} and page_no between ${from} and ${last}
    order by page_no`;
  const pages: PageContent[] = rows.map((page) =>
    page.text.length > PAGE_TEXT_CHARS ? { ...page, text: page.text.slice(0, PAGE_TEXT_CHARS), truncated: true } : page,
  );
  return { pages, ...(last < to ? { more: { from: last + 1, to } } : {}) };
};
