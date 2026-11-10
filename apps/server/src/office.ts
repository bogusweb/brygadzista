import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { config } from "./config.js";
import { sandboxed, toolEnv } from "./sandbox.js";

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

// Fields that pull in another file or a network address when the document opens (#169).
const LINKING_FIELD = /\b(INCLUDEPICTURE|INCLUDETEXT|DDEAUTO|DDE)\b/;
const LINKING_FIELD_UTF16 = ["INCLUDEPICTURE", "INCLUDETEXT", "DDEAUTO"].map((name) => Buffer.from(name, "utf16le"));
const LINKING_FIELD_LATIN1 = ["INCLUDEPICTURE", "INCLUDETEXT", "DDEAUTO"].map((name) => Buffer.from(name, "latin1"));
const LINKED_CONTENT = "Plik Word odwołuje się do innych plików lub adresów w sieci. Zapisz go z osadzonymi obrazami i wyślij ponownie.";
const MAX_PART_BYTES = 64 * 1024 * 1024;

type ZipEntry = { name: string; method: number; compressedSize: number; offset: number };

// The central directory of a zip, read from its end, so a large file is never read whole.
type Zip = { entries: ZipEntry[]; read: (entry: ZipEntry) => Promise<string>; close: () => Promise<void> };

const zipEntries = async (file: string): Promise<Zip> => {
  const handle = await open(file);
  const { size } = await handle.stat();
  const tailSize = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailSize);
  await handle.read(tail, 0, tailSize, size - tailSize);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) {
    await handle.close();
    throw new Error("not a zip");
  }
  const count = tail.readUInt16LE(end + 10);
  const dirSize = tail.readUInt32LE(end + 12);
  const dirOffset = tail.readUInt32LE(end + 16);
  const dir = Buffer.alloc(dirSize);
  await handle.read(dir, 0, dirSize, dirOffset);
  const entries: ZipEntry[] = [];
  for (let at = 0, i = 0; i < count && at + 46 <= dir.length && dir.readUInt32LE(at) === 0x02014b50; i++) {
    const nameLength = dir.readUInt16LE(at + 28);
    entries.push({
      method: dir.readUInt16LE(at + 10),
      compressedSize: dir.readUInt32LE(at + 20),
      offset: dir.readUInt32LE(at + 42),
      name: dir.toString("utf8", at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
  }
  const read = async (entry: ZipEntry) => {
    const local = Buffer.alloc(30);
    await handle.read(local, 0, 30, entry.offset);
    const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const data = Buffer.alloc(Math.min(entry.compressedSize, MAX_PART_BYTES));
    await handle.read(data, 0, data.length, start);
    const raw = entry.method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }) : data;
    return raw.toString("utf8");
  };
  return { entries, read, close: () => handle.close() };
};

const docxProblem = async (file: string) => {
  let zip;
  try {
    zip = await zipEntries(file);
  } catch {
    return "To nie jest plik Word (.docx)";
  }
  const names = new Set(zip.entries.map((entry) => entry.name));
  // An ODT, an XLSX or any other zip renamed to .docx is not opened by LibreOffice's Word filter by accident.
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) {
    await zip.close();
    return "To nie jest plik Word (.docx)";
  }
  try {
    for (const entry of zip.entries) {
      if (!entry.name.startsWith("word/") || !/\.(xml|rels)$/.test(entry.name)) continue;
      const text = await zip.read(entry);
      if (entry.name.endsWith(".rels")) {
        // Only hyperlinks may point outside the file; an external image, OLE object or template is a link to fetch.
        for (const rel of text.matchAll(/<Relationship\b[^>]*>/g)) {
          if (/TargetMode="External"/.test(rel[0]) && !/Type="[^"]*\/hyperlink"/.test(rel[0])) return LINKED_CONTENT;
        }
      } else {
        for (const field of text.matchAll(/<w:instrText[^>]*>([^<]*)<|w:instr="([^"]*)"/g)) {
          if (LINKING_FIELD.test(field[1] ?? field[2] ?? "")) return LINKED_CONTENT;
        }
      }
    }
  } catch {
    return "Nie udało się odczytać pliku Word (.docx)";
  } finally {
    await zip.close();
  }
  return null;
};

// A binary .doc keeps its field codes as text, in UTF-16 or a single-byte code page.
const docProblem = async (file: string) => {
  const handle = await open(file);
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    const overlap = 64;
    for (let position = 0; ; position += chunk.length - overlap) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const part = chunk.subarray(0, bytesRead);
      if ([...LINKING_FIELD_UTF16, ...LINKING_FIELD_LATIN1].some((needle) => part.includes(needle))) return LINKED_CONTENT;
      if (bytesRead < chunk.length) break;
    }
  } finally {
    await handle.close();
  }
  return null;
};

// What is wrong with an uploaded Word file before LibreOffice opens it, or null (#169).
export const wordProblem = (extension: WordExtension, file: string) => (extension === "docx" ? docxProblem(file) : docProblem(file));

export class OfficeTimeout extends Error {}

// soffice is a wrapper that starts soffice.bin, so on timeout the whole process group is killed, not just the wrapper.
const runSoffice = (args: string[], source: string, work: string) =>
  new Promise<void>((resolve, reject) => {
    const [program, programArgs] = sandboxed("soffice", args, { read: [source], write: [work] }, work);
    const child = spawn(program, programArgs, { detached: true, stdio: ["ignore", "ignore", "pipe"], env: toolEnv(work) });
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

// LibreOffice loads linked images and other linked content when it opens a document: a local file (another firm's page
// image) or an address in the server's network. Blocking links from untrusted documents stops both; embedded images
// still print (#169). Macros stay off too.
const PROFILE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`;

// Converts a Word file to `target` (a PDF). Each run gets its own LibreOffice profile, so two uploads at once
// don't fight over one profile lock.
export const wordToPdf = async (source: string, target: string) => {
  const work = await mkdtemp(path.join(tmpdir(), "brygadzista-office-"));
  try {
    const outDir = path.join(work, "out");
    await mkdir(path.join(work, "profile", "user"), { recursive: true });
    await writeFile(path.join(work, "profile", "user", "registrymodifications.xcu"), PROFILE_SETTINGS);
    await runSoffice([
      `-env:UserInstallation=${pathToFileURL(path.join(work, "profile")).href}`,
      "--headless",
      "--norestore",
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      outDir,
      source,
    ], source, work);
    const converted = path.join(outDir, `${path.basename(source, path.extname(source))}.pdf`);
    // Copied, not renamed: the temp directory and DATA_DIR are often on different filesystems.
    await copyFile(converted, target).catch(() => {
      throw new Error("LibreOffice nie zapisał PDF");
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};
