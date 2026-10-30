import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { detectFormat, sourceFile } from "../src/cad.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { pdfPageCount, pdfPageText } from "../src/pdf.js";
import { documentPdf } from "../src/storage.js";
import { ADMIN, createProject, resetDatabase } from "./helpers.js";

const fixtures = path.join(import.meta.dirname, "fixtures");
const MODEL_DXF = path.join(fixtures, "rysunek-model.dxf");
const SHEET_DXF = path.join(fixtures, "rysunek-arkusz.dxf");

// The drawing tests need what the image installs (Python with ezdxf, rsvg-convert); without them they are skipped.
const hasCadTools = (() => {
  try {
    execFileSync(config.cadPython, ["-c", "import ezdxf"], { stdio: "ignore" });
    execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const upload = (projectId: string, body: Uint8Array, filename: string) =>
  app.request(`/api/projects/${projectId}/documents?filename=${filename}&autostart=0`, {
    method: "PUT",
    body: Uint8Array.from(body),
    headers: ADMIN,
  });

const documentRow = async (id: string) => {
  const [row] = await sql<{ status: string; pageCount: number; error: string | null }[]>`
    select status, page_count as "pageCount", error from documents where id = ${id}`;
  return row!;
};

// Conversions start after the request's transaction commits and run one at a time.
const conversionsIdle = async () => {
  for (let i = 0; i < 300; i++) {
    const [busy] = await sql`select 1 from documents where status = 'converting'`;
    if (!busy) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Konwersja trwa za długo");
};

const defaults = { dwg2dxf: config.dwg2dxf };
let projectId: string;

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
});

afterEach(() => {
  Object.assign(config, defaults);
  delete process.env.FAKE_DWG2DXF_SOURCE;
});

afterAll(async () => {
  await sql.end();
});

describe("detectFormat", () => {
  const head = (text: string) => Buffer.from(text, "latin1");

  it("recognises PDF, DWG and DXF by content", () => {
    expect(detectFormat(head("%PDF-1.7\n"))).toBe("pdf");
    expect(detectFormat(head("AC1032\0\0\0\0\0"))).toBe("dwg");
    expect(detectFormat(head("AC1015\0\0"))).toBe("dwg");
    expect(detectFormat(head("  0\r\nSECTION\r\n  2\r\nHEADER\r\n"))).toBe("dxf");
    expect(detectFormat(head("999\ndxfrw 0.6.3\n  0\nSECTION\n"))).toBe("dxf");
    expect(detectFormat(head("AutoCAD Binary DXF\r\n\x1a\0"))).toBe("dxf");
  });

  it("rejects anything else", () => {
    expect(detectFormat(head("PK\u0003\u0004 to jest zip"))).toBeNull();
    expect(detectFormat(head("AC9999"))).toBeNull();
    expect(detectFormat(head("0\nTABLES\n"))).toBeNull();
  });
});

describe.skipIf(!hasCadTools)("drawings", () => {
  it("turns an uploaded DXF into PDF sheets that wait for the start", async () => {
    const response = await upload(projectId, await readFile(MODEL_DXF), "rzut.dxf");
    expect(response.status).toBe(201);
    const { id, status } = (await response.json()) as { id: string; status: string };
    expect(status).toBe("converting");

    await conversionsIdle();

    expect(await documentRow(id)).toEqual({ status: "awaiting_start", pageCount: 2, error: null });
    const pdf = await documentPdf(id);
    expect(await pdfPageCount(pdf)).toBe(2);
    expect(await stat(await sourceFile(id, "dxf"))).toBeTruthy();
  });

  it("puts the texts of each sheet into the PDF text layer, without hidden layers", async () => {
    const { id } = (await (await upload(projectId, await readFile(MODEL_DXF), "rzut.dxf")).json()) as { id: string };
    await conversionsIdle();
    const pdf = await documentPdf(id);

    const first = await pdfPageText(pdf, 1);
    expect(first).toContain("Rzut parteru 1:50");
    expect(first).toMatch(/Kuchnia\s+Łazienka/);
    expect(first).toContain("9,39 m²");
    expect(first).toContain("Nadproże 2xL19/N150");
    expect(first).not.toContain("wyłączonej warstwie");
    expect(await pdfPageText(pdf, 2)).toContain("Przekrój A-A 1:50");
  });

  it("draws paperspace layouts with the modelspace texts their viewports show", async () => {
    const { id } = (await (await upload(projectId, await readFile(SHEET_DXF), "arkusz.dxf")).json()) as { id: string };
    await conversionsIdle();

    expect((await documentRow(id)).pageCount).toBe(1);
    const text = await pdfPageText(await documentPdf(id), 1);
    expect(text).toContain("Arkusz A-1");
    expect(text).toContain("Łazienka");
  });

  it("converts a DWG through dwg2dxf first", async () => {
    config.dwg2dxf = path.join(fixtures, "fake-dwg2dxf.sh");
    process.env.FAKE_DWG2DXF_SOURCE = MODEL_DXF;
    const response = await upload(projectId, Buffer.from("AC1032\0\0\0\0\0 rysunek"), "dom.dwg");
    const { id } = (await response.json()) as { id: string };

    await conversionsIdle();

    expect(await documentRow(id)).toMatchObject({ status: "awaiting_start", pageCount: 2 });
    expect(await stat(await sourceFile(id, "dwg"))).toBeTruthy();
  });

  it("shows why an unreadable DWG failed and tries again on resume", async () => {
    config.dwg2dxf = path.join(fixtures, "fake-dwg2dxf.sh");
    const { id } = (await (await upload(projectId, Buffer.from("AC1032\0\0 zepsuty"), "dom.dwg")).json()) as { id: string };
    await conversionsIdle();

    const failed = await documentRow(id);
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("Nie udało się odczytać pliku DWG");
    expect(failed.error).toContain("Failed to decode file");

    process.env.FAKE_DWG2DXF_SOURCE = MODEL_DXF;
    const resumed = await app.request(`/api/documents/${id}/resume`, { method: "POST", headers: ADMIN });
    expect(resumed.status).toBe(200);
    expect((await documentRow(id)).status).toBe("converting");
    await conversionsIdle();
    expect(await documentRow(id)).toMatchObject({ status: "awaiting_start", pageCount: 2 });
  });
});
