import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";

// Word descriptions (#157) are turned into a PDF on upload so they go through the same index as drawings.
export const WORD_EXTENSIONS = ["doc", "docx"] as const;
export type WordExtension = (typeof WORD_EXTENSIONS)[number];

export const wordExtension = (filename: string): WordExtension | null => {
  const extension = path.extname(filename).slice(1).toLowerCase();
  return (WORD_EXTENSIONS as readonly string[]).includes(extension) ? (extension as WordExtension) : null;
};

// .doc is an OLE2 compound file, .docx a zip.
const SIGNATURES: Record<WordExtension, Buffer> = {
  doc: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  docx: Buffer.from("PK\u0003\u0004"),
};

export const looksLikeWord = (extension: WordExtension, head: Buffer) =>
  head.subarray(0, SIGNATURES[extension].length).equals(SIGNATURES[extension]);

export class OfficeTimeout extends Error {}

// soffice is a wrapper that starts soffice.bin, so on timeout the whole process group is killed, not just the wrapper.
const runSoffice = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("soffice", args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
      reject(new OfficeTimeout(`LibreOffice nie skończył w ${config.officeTimeoutMs / 1000} s`));
    }, config.officeTimeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice zakończył się kodem ${code}: ${stderr.trim()}`));
    });
  });

// Converts a Word file to `target` (a PDF). Each run gets its own LibreOffice profile, so two uploads at once
// don't fight over one profile lock.
export const wordToPdf = async (source: string, target: string) => {
  const work = await mkdtemp(path.join(tmpdir(), "brygadzista-office-"));
  try {
    const outDir = path.join(work, "out");
    await runSoffice([
      `-env:UserInstallation=${pathToFileURL(path.join(work, "profile")).href}`,
      "--headless",
      "--norestore",
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      outDir,
      source,
    ]);
    const converted = path.join(outDir, `${path.basename(source, path.extname(source))}.pdf`);
    // Copied, not renamed: the temp directory and DATA_DIR are often on different filesystems.
    await copyFile(converted, target).catch(() => {
      throw new Error("LibreOffice nie zapisał PDF");
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};
