import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

// A broken or enormous sheet must not hang an indexing worker, so every poppler call has a timeout.
const run = (command: string, args: string[], maxBuffer = 1024 * 1024) =>
  execFileAsync(command, args, { timeout: config.pdfToolTimeoutMs, maxBuffer });

// Vision models downscale anything bigger anyway, and pages are also sent to phones.
export const MAX_JPEG_BYTES = 2.5 * 1024 * 1024;
const JPEG_QUALITIES = [85, 70, 55];

export const pdfPageCount = async (file: string): Promise<number> => {
  const { stdout } = await run("pdfinfo", [file]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error("Nie udało się odczytać liczby stron PDF");
  return Number(match[1]);
};

// Page size in PDF points (1/72 inch), as displayed (rotation applied).
export const pdfPageSize = async (file: string, page: number): Promise<{ width: number; height: number }> => {
  const { stdout } = await run("pdfinfo", ["-f", `${page}`, "-l", `${page}`, file]);
  const size = stdout.match(/^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/m);
  if (!size) throw new Error(`Nie udało się odczytać rozmiaru strony ${page}`);
  const rotation = Number(stdout.match(/^Page\s+\d+\s+rot:\s+(\d+)/m)?.[1] ?? 0);
  const [width, height] = [Number(size[1]), Number(size[2])];
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width };
};

export const pdfPageText = async (file: string, page: number): Promise<string> => {
  const { stdout } = await run("pdftotext", ["-f", `${page}`, "-l", `${page}`, "-layout", "-enc", "UTF-8", file, "-"], 32 * 1024 * 1024);
  return stdout.replace(/\f/g, "").trim();
};

// Lowers JPEG quality until the file fits MAX_JPEG_BYTES; the last attempt is kept either way.
const renderJpeg = async (file: string, page: number, outPrefix: string, area: string[]) => {
  const out = `${outPrefix}.jpg`;
  for (const quality of JPEG_QUALITIES) {
    await run("pdftoppm", ["-f", `${page}`, "-l", `${page}`, "-jpeg", "-jpegopt", `quality=${quality}`, "-singlefile", ...area, file, outPrefix]);
    if ((await stat(out)).size <= MAX_JPEG_BYTES) break;
  }
  return out;
};

// Renders one page to JPEG, longest edge capped so drawings stay legible on a phone and for vision.
export const pdfRenderPage = (file: string, page: number, outPrefix: string) =>
  renderJpeg(file, page, outPrefix, ["-scale-to", "2200"]);

// Renders a crop of the page at the given DPI; x, y, width and height are pixels at that DPI.
export const pdfRenderRegion = (
  file: string,
  page: number,
  outPrefix: string,
  region: { dpi: number; x: number; y: number; width: number; height: number },
) =>
  renderJpeg(file, page, outPrefix, [
    "-r", `${region.dpi}`, "-x", `${region.x}`, "-y", `${region.y}`, "-W", `${region.width}`, "-H", `${region.height}`,
  ]);
