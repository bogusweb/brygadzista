import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const pdfPageCount = async (file: string): Promise<number> => {
  const { stdout } = await run("pdfinfo", [file]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error("Nie udało się odczytać liczby stron PDF");
  return Number(match[1]);
};

export const pdfPageText = async (file: string, page: number): Promise<string> => {
  const { stdout } = await run("pdftotext", ["-f", `${page}`, "-l", `${page}`, "-layout", "-enc", "UTF-8", file, "-"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.replace(/\f/g, "").trim();
};

// Renders one page to JPEG, longest edge capped so drawings stay legible on a phone and for vision.
export const pdfRenderPage = async (file: string, page: number, outPrefix: string): Promise<string> => {
  await run("pdftoppm", ["-f", `${page}`, "-l", `${page}`, "-jpeg", "-jpegopt", "quality=85", "-singlefile", "-scale-to", "2200", file, outPrefix]);
  return `${outPrefix}.jpg`;
};
