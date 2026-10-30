import { execFile } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { detached, sql } from "./db.js";
import { pdfPageCount } from "./pdf.js";
import { documentDir, documentPdf } from "./storage.js";

const execFileAsync = promisify(execFile);

// CAD drawings in the project index (#154, #155). The index reads PDFs only, so a DWG becomes a DXF (LibreDWG), and the
// DXF a PDF with one page per sheet (cad/render_dxf.py). The originals stay next to the PDF.
export type UploadFormat = "pdf" | "dwg" | "dxf";

const BINARY_DXF = "AutoCAD Binary DXF";

// Recognised by content, not by name: "%PDF-", a DWG version tag ("AC1032" for AutoCAD 2018), or a DXF that opens with
// its first section ("0" then "SECTION", in text or binary form).
export const detectFormat = (head: Buffer): UploadFormat | null => {
  const text = head.toString("latin1");
  if (text.startsWith("%PDF-")) return "pdf";
  if (/^AC10\d\d/.test(text)) return "dwg";
  if (text.startsWith(BINARY_DXF)) return "dxf";
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((line) => line.trim());
  const first = lines.findIndex((line) => line !== "");
  // A comment group (999 + its text) may come before the first section.
  const start = lines[first] === "999" ? first + 2 : first;
  return lines[start] === "0" && lines[start + 1] === "SECTION" ? "dxf" : null;
};

export const sourceFile = async (documentId: string, format: Exclude<UploadFormat, "pdf">) =>
  path.join(await documentDir(documentId), `source.${format}`);

const run = (command: string, args: string[]) =>
  execFileAsync(command, args, { timeout: config.cadToolTimeoutMs, maxBuffer: 16 * 1024 * 1024 });

const failure = (error: unknown) => {
  const { stderr, killed } = error as { stderr?: string; killed?: boolean };
  if (killed) return "przekroczony czas";
  const lines = (stderr ?? String(error)).trim().split("\n").filter(Boolean);
  return lines.at(-1) ?? String(error);
};

// LibreDWG prints warnings for objects it skips and still writes the DXF; only a missing or empty file is a failure.
export const dwgToDxf = async (dwg: string, dxf: string) => {
  try {
    await run(config.dwg2dxf, ["-y", "-o", dxf, dwg]);
  } catch (error) {
    const written = await stat(dxf).then((file) => file.size > 0, () => false);
    if (!written) throw new Error(`Nie udało się odczytać pliku DWG (${failure(error)})`);
  }
};

export type RenderSummary = { dxfVersion: string; repairs: number; pages: { name: string; texts: number }[] };

export const dxfToPdf = async (dxf: string, pdf: string): Promise<RenderSummary> => {
  try {
    const { stdout } = await run(config.cadPython, [config.cadRenderScript, dxf, pdf]);
    return JSON.parse(stdout) as RenderSummary;
  } catch (error) {
    throw new Error(`Nie udało się narysować arkuszy z DXF (${failure(error)})`);
  }
};

// Turns the uploaded drawing into the document's PDF and hands it on to indexing. It runs after the upload has answered,
// because a large drawing takes longer than a request should; the dashboard shows 'converting' meanwhile. The cost
// estimate needs the page count, so indexing always waits for the start button afterwards.
const convertDrawing = async (documentId: string, format: Exclude<UploadFormat, "pdf">) => {
  let partial: string | undefined;
  try {
    const dxf = await sourceFile(documentId, "dxf");
    if (format === "dwg") await dwgToDxf(await sourceFile(documentId, "dwg"), dxf);
    const pdf = await documentPdf(documentId);
    partial = `${pdf}.part`;
    const summary = await dxfToPdf(dxf, partial);
    await rename(partial, pdf);
    const pageCount = await pdfPageCount(pdf);
    if (pageCount > config.maxPages) throw new Error(`Rysunek ma ${pageCount} arkuszy, limit to ${config.maxPages}`);
    await sql`update documents set status = 'awaiting_start', page_count = ${pageCount}, error = null
      where id = ${documentId} and status = 'converting'`;
    console.log(`cad: document ${documentId} has ${pageCount} sheets (${summary.pages.map((page) => page.name).join(", ")})`);
  } catch (error) {
    console.error(`cad: document ${documentId} failed`, error);
    if (partial) await rm(partial, { force: true });
    await sql`update documents set status = 'error', error = ${error instanceof Error ? error.message : String(error)}
      where id = ${documentId} and status = 'converting'`;
  }
};

// One drawing at a time: the server has two cores and indexing needs them too.
let queue = Promise.resolve();
export const enqueueConversion = (documentId: string, format: Exclude<UploadFormat, "pdf">) => {
  queue = queue.then(() => convertDrawing(documentId, format));
  return queue;
};


const exists = (file: string) => stat(file).then(() => true, () => false);

// The drawing a document was made from, when its PDF is missing because the conversion failed or never finished.
const unconvertedDrawing = async (documentId: string) => {
  if (await exists(await documentPdf(documentId))) return null;
  if (await exists(await sourceFile(documentId, "dwg"))) return "dwg";
  return (await exists(await sourceFile(documentId, "dxf"))) ? "dxf" : null;
};

// Resuming a drawing whose conversion failed tries the conversion again instead of queueing a document without a PDF.
export const convertAgainIfNeeded = async (documentId: string) => {
  const format = await unconvertedDrawing(documentId);
  if (!format) return false;
  await sql`update documents set status = 'converting', error = null where id = ${documentId}`;
  detached(() => enqueueConversion(documentId, format));
  return true;
};

// A restart stops a conversion halfway; it starts again from the original.
export const resumeConversions = async () => {
  const pending = await sql<{ id: string }[]>`select id from documents where status = 'converting' order by created_at`;
  for (const doc of pending) {
    const format = await unconvertedDrawing(doc.id);
    if (format) detached(() => enqueueConversion(doc.id, format));
  }
};
