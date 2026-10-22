import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { buildOutline, parseToc, sheetTitle, titleSimilarity, type OutlineSection } from "../src/outline.js";
import { MAX_PAGES_PER_CALL, projectOutline, readPages } from "../src/project-outline.js";
import { ADMIN, createDocument, createProject, resetDatabase } from "./helpers.js";

// A drawing's title block as `pdftotext -layout` prints it: the label, the title under it, then the next field.
const drawing = (title: string, before = "") =>
  `${before}\n                                            RYSUNEK:\n                                                   ${title}\n` +
  `                                            OBIEKT:\n                                            Hala sportowa`;

const CONTENTS = `                  SPIS ZAWARTOŚCI PROJEKTU:
STRONA TYTUŁOWA PROJEKTU                                                   str. 1
SPIS ZAWARTOŚCI                                                            str. 2
OPIS PROJEKTU TECHNICZNEGO                                                 str. 3-5
RZUT PRZYZIEMIA                                             – rys. nr 1    str. 6
RZUT DACHU                                                  – rys. nr 2    str. 7
PRZEKRÓJ A-A                                                – rys. nr 3    str. 8
DETAL 1 – SPOSÓB KLEJENIA IZOLACJI TERMICZNEJ               – rys. nr 4    str. 9
DETAL 10 – ROZMIESZCZENIE ŁĄCZNIKÓW MOCUJĄCYCH PŁYTY
IZOLACYJNE – PAS KRAWĘDZIOWY                                – rys. nr 5    str. 10
OŚWIADCZENIE PROJEKTANTA                                                   str. 11
UPRAWNIENIA PROJEKTANTÓW                                                   str. 12-13`;

// The statement listed last is bound right after the description, so every drawing sits one page later than listed,
// and the scans of the licences at the end have no text at all.
const SAMPLE = [
  "PROJEKT TECHNICZNY\nTermomodernizacja hali sportowej",
  CONTENTS,
  "OPIS TECHNICZNY\nI.   DANE WYJŚCIOWE\nProjekt wykonano na zlecenie Inwestora.\nII.  OGÓLNA CHARAKTERYSTYKA BUDYNKU\nBudynek parterowy.",
  "III. OPIS PROJEKTOWANYCH PRAC\n1. Wymiana stolarki okiennej\n2. Docieplenie ścian zewnętrznych\nKolejność robót:\n1. prace przygotowawcze,\n2. przyklejenie płyt,",
  "3. Wykonanie pokrycia dachowego\nIV. Ochrona przeciwpożarowa",
  "Biała Podlaska, czerwiec 2023 r.\nOŚWIADCZENIE\nOświadczam, że projekt sporządzono zgodnie z przepisami.",
  drawing("RZUT PRZYZIEMIA", "opaska z geokraty"),
  drawing("RZUT DACHU"),
  drawing("PRZEKRÓJ A\u00adA", "tynk                            - 0,38"),
  drawing("DETAL 1 \u00ad SPOSÓB KLEJENIE IZOLACJI TERMICZNEJ"),
  drawing("DETAL 10 \u00ad ROZMIESZCZENIE ŁĄCZNIKÓW MOCUJĄCYCH"),
  "",
  "",
].map((text, i) => ({ pageNo: i + 1, text }));

const flat = (sections: OutlineSection[]) => sections.map(({ title, from, to }) => `${from}-${to} ${title}`);

describe("contents page", () => {
  it("reads entries with page ranges, drawing numbers and titles wrapped onto two lines", () => {
    const entries = parseToc(CONTENTS);
    expect(entries).toHaveLength(10);
    expect(entries[2]).toEqual({ title: "OPIS PROJEKTU TECHNICZNEGO", from: 3, to: 5 });
    expect(entries[3]).toEqual({ title: "RZUT PRZYZIEMIA", from: 6, to: 6, drawingNo: "1" });
    expect(entries[7]).toEqual({
      title: "DETAL 10 – ROZMIESZCZENIE ŁĄCZNIKÓW MOCUJĄCYCH PŁYTY IZOLACYJNE – PAS KRAWĘDZIOWY",
      from: 10,
      to: 10,
      drawingNo: "5",
    });
  });

  it("finds the title in a drawing's title block, also when other text shares the line", () => {
    expect(sheetTitle(drawing("RZUT DACHU"))).toBe("RZUT DACHU");
    expect(sheetTitle(drawing("PRZEKRÓJ A\u00adA", "tynk    - 0,38"))).toBe("PRZEKRÓJ A A");
    expect(sheetTitle("Opis techniczny bez tabelki")).toBeNull();
  });

  it("compares titles despite inflection and typos, but never mixes up numbered details", () => {
    expect(titleSimilarity("DETAL 1 – SPOSÓB KLEJENIA IZOLACJI", "DETAL 1 SPOSÓB KLEJENIE IZOLACJI")).toBe(1);
    expect(titleSimilarity("DETAL 1 – SPOSÓB KLEJENIA", "DETAL 10 – SPOSÓB KLEJENIA")).toBe(0);
    expect(titleSimilarity("OPIS PROJEKTU TECHNICZNEGO", "OPIS TECHNICZNY")).toBe(1);
    expect(titleSimilarity("UPRAWNIENIA PROJEKTANTÓW", "PROJEKT TECHNICZNY")).toBe(0);
  });
});

describe("outline", () => {
  it("places every part on its real pages when the contents is off by an inserted page", () => {
    const outline = buildOutline(SAMPLE);

    expect(outline).toMatchObject({ source: "toc", tocPage: 2 });
    expect(flat(outline.sections)).toEqual([
      "1-1 STRONA TYTUŁOWA PROJEKTU",
      "2-2 SPIS ZAWARTOŚCI",
      "3-5 OPIS PROJEKTU TECHNICZNEGO",
      "6-6 OŚWIADCZENIE PROJEKTANTA",
      "7-7 RZUT PRZYZIEMIA",
      "8-8 RZUT DACHU",
      "9-9 PRZEKRÓJ A-A",
      "10-10 DETAL 1 – SPOSÓB KLEJENIA IZOLACJI TERMICZNEJ",
      "11-11 DETAL 10 – ROZMIESZCZENIE ŁĄCZNIKÓW MOCUJĄCYCH PŁYTY IZOLACYJNE – PAS KRAWĘDZIOWY",
      "12-13 UPRAWNIENIA PROJEKTANTÓW",
    ]);
    const roof = outline.sections.find((section) => section.title === "RZUT DACHU");
    expect(roof).toEqual({ title: "RZUT DACHU", from: 8, to: 8, kind: "rzut", drawingNo: "2", declared: { from: 7, to: 7 }, verified: true });
    expect(outline.sections.find((section) => section.title.startsWith("DETAL 1 "))?.kind).toBe("detal");
    // Matched by its heading, and the pages around it are not dragged along.
    expect(outline.sections.find((section) => section.title === "OŚWIADCZENIE PROJEKTANTA")?.verified).toBe(true);
    expect(outline.sections.find((section) => section.title.startsWith("UPRAWNIENIA"))?.verified).toBe(false);
  });

  it("splits the technical description into chapters and points, skipping numbered work steps", () => {
    const description = buildOutline(SAMPLE).sections.find((section) => section.kind === "opis")!;

    expect(description.children?.map(({ title, from, to }) => `${from}-${to} ${title}`)).toEqual([
      "3-3 I. DANE WYJŚCIOWE",
      "3-4 II. OGÓLNA CHARAKTERYSTYKA BUDYNKU",
      "4-5 III. OPIS PROJEKTOWANYCH PRAC",
      "5-5 IV. Ochrona przeciwpożarowa",
    ]);
    expect(description.children?.[2]?.children?.map((point) => point.title)).toEqual([
      "1. Wymiana stolarki okiennej",
      "2. Docieplenie ścian zewnętrznych",
      "3. Wykonanie pokrycia dachowego",
    ]);
  });

  it("lists pages the contents leaves out", () => {
    const contents = CONTENTS.split("\n").filter((line) => !line.startsWith("OŚWIADCZENIE")).join("\n");
    const outline = buildOutline(SAMPLE.map((page) => (page.pageNo === 2 ? { ...page, text: contents } : page)));
    expect(outline.sections.find((section) => section.from === 6)).toEqual({ title: "OŚWIADCZENIE", from: 6, to: 6, verified: true, extra: true });
    expect(outline.sections.find((section) => section.title === "RZUT PRZYZIEMIA")?.from).toBe(7);
  });

  it("without a contents page groups the pages by their titles", () => {
    const outline = buildOutline([
      { pageNo: 1, text: "OPIS TECHNICZNY\nI. DANE\nII. KONSTRUKCJA" },
      { pageNo: 2, text: drawing("RZUT PARTERU") },
      { pageNo: 3, text: "" },
      { pageNo: 4, text: "" },
    ]);
    expect(outline.source).toBe("pages");
    expect(flat(outline.sections)).toEqual(["1-1 OPIS TECHNICZNY", "2-2 RZUT PARTERU", "3-4 Strona bez tekstu (skan lub rysunek)"]);
  });
});

let projectId: string;

const insertTexts = async (documentId: string, pages: { pageNo: number; text: string }[]) => {
  for (const page of pages) {
    await sql`insert into pages (document_id, project_id, page_no, raw_text, search_text, title)
      values (${documentId}, ${projectId}, ${page.pageNo}, ${page.text}, ${page.text || `Strona ${page.pageNo}`}, ${`Strona ${page.pageNo}`})`;
  }
};

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
});

afterAll(async () => {
  await sql.end();
});

describe("stored outline", () => {
  it("is built for documents indexed before outlines existed and returned by the API", async () => {
    const documentId = await createDocument(projectId, "ready");
    await sql`update documents set page_count = ${SAMPLE.length} where id = ${documentId}`;
    await insertTexts(documentId, SAMPLE);

    const response = await app.request(`/api/documents/${documentId}/outline`, { headers: ADMIN });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { filename: string; outline: { sections: OutlineSection[] } };
    expect(body.filename).toBe("projekt.pdf");
    expect(body.outline.sections.find((section) => section.title === "RZUT DACHU")?.from).toBe(8);
    const [stored] = await sql<{ outline: { version: number } | null }[]>`select outline from documents where id = ${documentId}`;
    expect(stored!.outline?.version).toBe(1);
  });

  it("has no outline while the document is still being indexed", async () => {
    await createDocument(projectId, "processing");
    expect((await projectOutline(projectId))[0]?.outline).toBeNull();
  });

  it("reads at most a few pages per call and says where to continue", async () => {
    const documentId = await createDocument(projectId, "ready");
    await insertTexts(documentId, SAMPLE);

    const result = await readPages(projectId, documentId, 3, 12);

    expect(result.pages.map((page) => page.pageNo)).toEqual([3, 4, 5, 6, 7].slice(0, MAX_PAGES_PER_CALL));
    expect(result.pages[0]?.text).toContain("DANE WYJŚCIOWE");
    expect(result.more).toEqual({ from: 3 + MAX_PAGES_PER_CALL, to: 12 });
    const otherProject = await createProject("Inny");
    expect((await readPages(otherProject, documentId, 3, 4)).pages).toEqual([]);
  });
});
