import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { looksLikeWord, wordExtension } from "../src/office.js";
import { pdfPageText } from "../src/pdf.js";
import { documentDir, documentPdf } from "../src/storage.js";
import { ADMIN, createProject, resetDatabase } from "./helpers.js";

const execFileAsync = promisify(execFile);

const upload = (projectId: string, filename: string, body: Uint8Array<ArrayBuffer>) =>
  app.request(`/api/projects/${projectId}/documents?filename=${encodeURIComponent(filename)}`, { method: "PUT", body, headers: ADMIN });

// A two-page description with Polish letters and a room table, written by LibreOffice itself so no client file
// lands in the repository.
const DESCRIPTION = `<html><body>
<h1>Opis architektoniczno-budowlany</h1>
<p>Zażółć gęślą jaźń. Budynek parterowy, niepodpiwniczony.</p>
<table border="1"><tr><th>Lp.</th><th>Pomieszczenie</th><th>Powierzchnia</th></tr>
<tr><td>1</td><td>Wiatrołap</td><td>5,01 m2</td></tr><tr><td>2</td><td>Łazienka</td><td>6,40 m2</td></tr></table>
<p style="page-break-before: always">Strona druga: ściany z bloczków silikatowych.</p>
</body></html>`;

const makeWord = async (extension: "doc" | "docx") => {
  const dir = await mkdtemp(path.join(tmpdir(), "brygadzista-word-"));
  const html = path.join(dir, "opis.html");
  await writeFile(html, DESCRIPTION);
  const filter = extension === "doc" ? "doc:MS Word 97" : "docx:MS Word 2007 XML";
  await execFileAsync("soffice", [
    `-env:UserInstallation=file://${path.join(dir, "profile")}`,
    "--headless", "--writer", "--convert-to", filter, "--outdir", dir, html,
  ], { timeout: 120_000 });
  return new Uint8Array(await readFile(path.join(dir, `opis.${extension}`)));
};

const words: Record<"doc" | "docx", Uint8Array<ArrayBuffer>> = {} as never;
const defaultTimeout = config.officeTimeoutMs;
let projectId: string;

beforeAll(async () => {
  words.doc = await makeWord("doc");
  words.docx = await makeWord("docx");
}, 120_000);

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
});

afterEach(() => {
  config.officeTimeoutMs = defaultTimeout;
});

afterAll(async () => {
  await sql.end();
});

describe("Word file detection", () => {
  it("takes .doc and .docx in any letter case and nothing else", () => {
    expect(wordExtension("Opis.DOC")).toBe("doc");
    expect(wordExtension("opis techniczny.docx")).toBe("docx");
    expect(wordExtension("opis.pdf")).toBeNull();
    expect(wordExtension("opis.doc.pdf")).toBeNull();
  });

  it("checks the file signature against the extension", () => {
    expect(looksLikeWord("doc", Buffer.from(words.doc.subarray(0, 8)))).toBe(true);
    expect(looksLikeWord("docx", Buffer.from(words.docx.subarray(0, 8)))).toBe(true);
    expect(looksLikeWord("doc", Buffer.from(words.docx.subarray(0, 8)))).toBe(false);
  });
});

describe("Word upload", () => {
  it.each(["doc", "docx"] as const)("converts a .%s to PDF and keeps the original next to it", async (extension) => {
    const response = await upload(projectId, `opis.${extension}`, words[extension]);

    expect(response.status).toBe(201);
    const { id, pageCount } = (await response.json()) as { id: string; pageCount: number };
    expect(pageCount).toBe(2);
    const [doc] = await sql`select filename, status from documents where id = ${id}`;
    expect(doc).toMatchObject({ filename: `opis.${extension}`, status: "queued" });
    expect((await readdir(await documentDir(id))).sort()).toEqual(["source.pdf", `source.${extension}`].sort());
    expect(new Uint8Array(await readFile(path.join(await documentDir(id), `source.${extension}`)))).toEqual(words[extension]);

    const first = await pdfPageText(await documentPdf(id), 1);
    expect(first).toContain("Zażółć gęślą jaźń");
    expect(first).toMatch(/Wiatrołap\s+5,01 m2/);
    expect(first).toMatch(/Łazienka\s+6,40 m2/);
    expect(await pdfPageText(await documentPdf(id), 2)).toContain("ściany z bloczków silikatowych");
  });

  it("rejects a file whose content is not Word and leaves nothing behind", async () => {
    const response = await upload(projectId, "opis.doc", new TextEncoder().encode("%PDF-1.4 udaje Worda"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "To nie jest plik Word (.doc)" });
    expect(await sql`select id from documents`).toHaveLength(0);
  });

  it("rejects a broken Word file that LibreOffice cannot open", async () => {
    const broken = new Uint8Array(4096);
    broken.set(words.doc.subarray(0, 8));

    const response = await upload(projectId, "opis.doc", broken);

    expect(response.status).toBe(400);
    expect(await sql`select id from documents`).toHaveLength(0);
  });

  it("stops a conversion that runs past the time limit", async () => {
    config.officeTimeoutMs = 1;

    const response = await upload(projectId, "opis.docx", words.docx);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Zamiana pliku Word na PDF trwała za długo" });
    expect(await sql`select id from documents`).toHaveLength(0);
  });
});
