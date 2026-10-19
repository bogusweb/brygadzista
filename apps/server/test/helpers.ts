import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { migrate, sql } from "../src/db.js";
import { documentDir, documentPdf } from "../src/storage.js";

export const ADMIN = { authorization: "Bearer test-admin" };
export const APP = { authorization: "Bearer test-app" };

export const resetDatabase = async () => {
  await migrate();
  await sql`truncate projects cascade`;
};

export const createProject = async (name = "Hala sportowa") => {
  const [project] = await sql<{ id: string }[]>`insert into projects (name) values (${name}) returning id`;
  return project!.id;
};

export const createDocument = async (projectId: string, status = "queued") => {
  const [doc] = await sql<{ id: string }[]>`
    insert into documents (project_id, filename, status) values (${projectId}, 'projekt.pdf', ${status}) returning id`;
  return doc!.id;
};

export const writeDocumentPdf = async (documentId: string, pdf: Uint8Array) => {
  await mkdir(documentDir(documentId), { recursive: true });
  await writeFile(documentPdf(documentId), pdf);
};

export const insertPage = async (
  projectId: string,
  documentId: string,
  pageNo: number,
  fields: { title?: string; searchText?: string; indexed?: boolean } = {},
) => {
  const [page] = await sql<{ id: string }[]>`
    insert into pages (document_id, project_id, page_no, title, search_text, raw_text, indexed)
    values (${documentId}, ${projectId}, ${pageNo}, ${fields.title ?? null}, ${fields.searchText ?? ""},
      ${fields.searchText ?? ""}, ${fields.indexed ?? false})
    returning id`;
  return page!.id;
};

// A unit vector along one axis, padded to the embedding size.
export const axisVector = (axis: number) =>
  Array.from({ length: config.embeddingDimensions }, (_, i) => (i === axis ? 1 : 0));

// Smallest valid PDF with one line of Helvetica text per page, with a correct xref so poppler reads it.
// The page size is in points; the default is US Letter, A1 is 1684 x 2384.
export const makePdf = (pageTexts: string[], size = { width: 612, height: 792 }): Uint8Array<ArrayBuffer> => {
  const objects: string[] = [];
  const pageIds = pageTexts.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageTexts.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 ${size.height - 72} Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /Font << /F1 3 0 R >> >> ` +
      `/Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
};
