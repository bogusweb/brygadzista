import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { looksLikeWord, wordExtension, wordProblem, wordToPdf } from "../src/office.js";
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

// Rewrites one part of a .docx (a zip), so a test can add what a hostile file would carry.
const editDocx = async (docx: Uint8Array, part: string, edit: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), "brygadzista-word-edit-"));
  const file = path.join(dir, "in.docx");
  await writeFile(file, docx);
  const script = [
    "import sys, zipfile",
    "src, dst, part, old, new = sys.argv[1:6]",
    "zin = zipfile.ZipFile(src)",
    "zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)",
    "for item in zin.infolist():",
    "    data = zin.read(item.filename)",
    "    if item.filename == part: data = data.decode().replace(old, new, 1).encode()",
    "    zout.writestr(item, data)",
    "zout.close()",
  ].join("\n");
  const [old, replacement] = edit.split("=>");
  await execFileAsync("python3", ["-I", "-c", script, file, path.join(dir, "out.docx"), part, old!, replacement!]);
  return new Uint8Array(await readFile(path.join(dir, "out.docx")));
};

const LINKED_IMAGE_REL =
  '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
  'Target="file:///etc/hostname" TargetMode="External"/></Relationships>';

describe("Word files that reach outside themselves (#169)", () => {
  it("rejects a zip that is not a Word document, such as an ODT renamed to .docx", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brygadzista-odt-"));
    const html = path.join(dir, "opis.html");
    await writeFile(html, DESCRIPTION);
    await execFileAsync("soffice", [
      `-env:UserInstallation=file://${path.join(dir, "profile")}`, "--headless", "--writer", "--convert-to", "odt", "--outdir", dir, html,
    ], { timeout: 120_000 });

    const response = await upload(projectId, "opis.docx", new Uint8Array(await readFile(path.join(dir, "opis.odt"))));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "To nie jest plik Word (.docx)" });
    expect(await sql`select id from documents`).toHaveLength(0);
  });

  it("rejects a .docx with an image linked from outside the file", async () => {
    const linked = await editDocx(words.docx, "word/_rels/document.xml.rels", `</Relationships>=>${LINKED_IMAGE_REL}`);

    const response = await upload(projectId, "opis.docx", linked);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("odwołuje się do innych plików");
  });

  it("rejects a .docx with an INCLUDEPICTURE field", async () => {
    const field = "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText> INCLUDEPICTURE \"file:///etc/hostname\" </w:instrText></w:r>";
    const linked = await editDocx(words.docx, "word/document.xml", `<w:body>=><w:body><w:p>${field}</w:p>`);

    const response = await upload(projectId, "opis.docx", linked);

    expect(response.status).toBe(400);
  });

  it("keeps ordinary hyperlinks", async () => {
    const hyperlink =
      '<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
      'Target="https://example.com/" TargetMode="External"/></Relationships>';
    const withLink = await editDocx(words.docx, "word/_rels/document.xml.rels", `</Relationships>=>${hyperlink}`);

    expect(await wordProblem("docx", await saved(withLink))).toBeNull();
  });

  it("converts with linked content blocked, even when a file gets past the check", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brygadzista-word-link-"));
    const image = path.join(dir, "inna-firma.jpg");
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c00" } }).jpeg().toFile(image);
    const rel = LINKED_IMAGE_REL.replace("file:///etc/hostname", `file://${image}`);
    const drawing =
      '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      '<wp:extent cx="952500" cy="952500"/><wp:docPr id="99" name="P"/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="99" name="P"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:link="rIdX"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>";
    const withRel = await editDocx(words.docx, "word/_rels/document.xml.rels", `</Relationships>=>${rel}`);
    const linked = await editDocx(withRel, "word/document.xml", `<w:body>=><w:body><w:p>${drawing}</w:p>`);
    const source = await saved(linked);
    const pdf = path.join(dir, "out.pdf");

    await wordToPdf(source, pdf);

    const { stdout } = await execFileAsync("pdfimages", ["-list", pdf]);
    expect(stdout.trim().split("\n").slice(2)).toHaveLength(0);
  });
});

const saved = async (bytes: Uint8Array) => {
  const dir = await mkdtemp(path.join(tmpdir(), "brygadzista-word-file-"));
  const file = path.join(dir, "source.docx");
  await writeFile(file, bytes);
  return file;
};
