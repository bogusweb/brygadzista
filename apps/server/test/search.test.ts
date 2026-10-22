import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { migrate, sql } from "../src/db.js";
import { lexicalSearch, prefixQuery, searchPages, semanticSearch } from "../src/search.js";
import { configuredEmbedding, embeddingSetId } from "../src/embedding-model.js";
import { axisVector, createDocument, createProject, insertPage, resetDatabase } from "./helpers.js";

const embed = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());
vi.mock("../src/llm.js", () => ({ embed }));

const ACTIVE_SET = embeddingSetId(configuredEmbedding());

describe("prefixQuery", () => {
  it("turns each word into a prefix of its stem-ish head", () => {
    expect(prefixQuery("Grubość ocieplenia ścian")).toBe("grubo:* | ocieple:* | ścia:*");
  });

  it("keeps at least four letters and drops words shorter than three", () => {
    expect(prefixQuery("tynk na ścianie")).toBe("tynk:* | ścian:*");
  });

  it("splits on punctuation and keeps numbers", () => {
    expect(prefixQuery("rys. nr 4, ściana-300")).toBe("rys:* | ścian:* | 300:*");
  });

  it("drops question words and matches an abbreviation or its spelled-out name", () => {
    expect(prefixQuery("Jaka jest grubość MW?")).toBe("grubo:* | (mw:* | wełn:* | mineral:*)");
  });

  it("returns an empty query when no word is long enough", () => {
    expect(prefixQuery("a i w")).toBe("");
  });
});

afterAll(async () => {
  config.openrouterApiKey = "";
  await sql.end();
});

describe("searchPages", () => {
  let projectId: string;
  let documentId: string;

  beforeEach(async () => {
    await resetDatabase();
    embed.mockReset();
    config.openrouterApiKey = "";
    projectId = await createProject();
    documentId = await createDocument(projectId, "ready");
  });

  it("finds a page by an inflected form of the word", async () => {
    await insertPage(projectId, documentId, 1, { title: "Strona tytułowa", searchText: "Strona tytułowa projektu" });
    await insertPage(projectId, documentId, 7, { title: "Ściany zewnętrzne", searchText: "Docieplenie ścian zewnętrznych styropianem 15 cm" });

    const [first] = await searchPages(projectId, "ocieplenie ściany");

    expect(first).toMatchObject({ documentId, filename: "projekt.pdf", pageNo: 7, title: "Ściany zewnętrzne" });
    expect(first!.snippet).toContain("styropianem 15 cm");
  });

  it("ignores pages of other projects and pages not yet extracted", async () => {
    const otherProject = await createProject("Inny");
    const otherDocument = await createDocument(otherProject, "ready");
    await insertPage(otherProject, otherDocument, 1, { searchText: "Dach płaski, papa termozgrzewalna" });
    await insertPage(projectId, documentId, 1, { searchText: "" });

    expect(await searchPages(projectId, "papa dach")).toEqual([]);
  });

  it("does not call embeddings without an API key", async () => {
    await insertPage(projectId, documentId, 1, { searchText: "Posadzka betonowa" });

    await searchPages(projectId, "posadzka");

    expect(embed).not.toHaveBeenCalled();
  });

  it("fuses the semantic ranking with the lexical one", async () => {
    config.openrouterApiKey = "test-key";
    const lexicalPage = await insertPage(projectId, documentId, 2, { searchText: "Zestawienie stolarki: okna PCV" });
    const semanticPage = await insertPage(projectId, documentId, 9, { searchText: "Detal attyki" });
    await sql`insert into chunks (page_id, project_id, content, embedding, embedding_set) values
      (${semanticPage}, ${projectId}, 'attyka', ${`[${axisVector(0).join(",")}]`}::vector, ${ACTIVE_SET}),
      (${lexicalPage}, ${projectId}, 'okna', ${`[${axisVector(1).join(",")}]`}::vector, ${ACTIVE_SET})`;
    embed.mockResolvedValue([axisVector(0)]);

    const hits = await searchPages(projectId, "okna", 2);

    expect(embed).toHaveBeenCalledWith(["okna"], expect.objectContaining({ id: ACTIVE_SET }));
    expect(hits.map((hit) => hit.pageNo).sort()).toEqual([2, 9]);
  });

  it("ranks a page holding the exact code first, whichever way it is written", async () => {
    await insertPage(projectId, documentId, 3, { searchText: "Ściany docieplone, rury spustowe wymienione, norma do przemarzania gruntu" });
    await insertPage(projectId, documentId, 7, { searchText: "Głębokość przemarzania wg PN-81/B-03020, rynny ∅150, rury spustowe Ø120mm" });

    expect((await searchPages(projectId, "PN-81/B-03020"))[0]?.pageNo).toBe(7);
    expect((await searchPages(projectId, "rury spustowe Ø120"))[0]?.pageNo).toBe(7);
  });

  it("finds a detail mark written with a leading zero", async () => {
    await insertPage(projectId, documentId, 2, { searchText: "SPIS ZAWARTOŚCI PROJEKTU rys. nr 10 Szczegóły" });
    await insertPage(projectId, documentId, 24, { searchText: "SZCZEGÓŁ A4 ocieplenie ościeża okna" });

    expect((await searchPages(projectId, "rys. a04"))[0]?.pageNo).toBe(24);
  });

  it("re-extracts codes of pages stored with an older extraction at startup", async () => {
    const pageId = await insertPage(projectId, documentId, 24, { searchText: "SZCZEGÓŁ A4" });
    await sql`update pages set codes = ${["a04"]}, codes_version = 1 where id = ${pageId}`;

    await migrate();

    const [page] = await sql<{ codes: string[] }[]>`select codes from pages where id = ${pageId}`;
    expect(page?.codes).toContain("a4");
  });

  it("expands trade abbreviations in the query", async () => {
    await insertPage(projectId, documentId, 4, { searchText: "Ocieplenie ścian wełną mineralną gr. 15 cm" });
    await insertPage(projectId, documentId, 5, { searchText: "Tynk cienkowarstwowy na ścianach" });

    expect((await searchPages(projectId, "grubość MW"))[0]?.pageNo).toBe(4);
  });

  it("returns nothing when no page holds enough of the question's words", async () => {
    await insertPage(projectId, documentId, 5, { searchText: "Stropy żelbetowe z płyt kanałowych w dobrym stanie" });

    expect(await searchPages(projectId, "Gdzie montujemy panele fotowoltaiczne na dachu?")).toEqual([]);
  });

  it("returns the part of the page around the question's words as the snippet", async () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Linia opisu numer ${i} bez znaczenia dla pytania`).join("\n");
    await insertPage(projectId, documentId, 8, { searchText: `${filler}\nWłaz dachowy uchylny 80x80cm\n${filler}` });

    const [hit] = await searchPages(projectId, "jaki jest właz dachowy");

    expect(hit!.snippet).toContain("Właz dachowy uchylny 80x80cm");
    expect(hit!.snippet.length).toBeLessThanOrEqual(600);
  });

  it("caps the number of results", async () => {
    for (let pageNo = 1; pageNo <= 5; pageNo++) {
      await insertPage(projectId, documentId, pageNo, { searchText: `Rzut kondygnacji ${pageNo}` });
    }

    expect(await searchPages(projectId, "rzut", 3)).toHaveLength(3);
  });
});

describe("searchPages with page metadata (#55)", () => {
  let projectId: string;
  let documentId: string;

  const setMeta = (pageId: string, meta: { kind?: string; drawingNo?: string; branch?: string; level?: string }) =>
    sql`update pages set kind = ${meta.kind ?? null}, drawing_no = ${meta.drawingNo ?? null}, branch = ${meta.branch ?? null},
      level = ${meta.level ?? null} where id = ${pageId}`;

  beforeEach(async () => {
    await resetDatabase();
    config.openrouterApiKey = "";
    projectId = await createProject();
    documentId = await createDocument(projectId, "ready");
  });

  it("puts the sheet carrying a drawing number before the table of contents that lists it", async () => {
    const toc = await insertPage(projectId, documentId, 2, { searchText: "SPIS ZAWARTOŚCI PROJEKTU RZUT DACHU rys. nr 5 str. 17" });
    const roof = await insertPage(projectId, documentId, 18, { searchText: "Rynna Ø150 RYSUNEK: RZUT DACHU NR RYS.: 5." });
    await setMeta(toc, { kind: "formalne" });
    await setMeta(roof, { kind: "rysunek", drawingNo: "5" });

    expect((await searchPages(projectId, "Co jest na rys. nr 5?")).map((hit) => hit.pageNo)[0]).toBe(18);
  });

  it("filters by kind, trade and storey", async () => {
    const description = await insertPage(projectId, documentId, 4, { searchText: "Rzut parteru opisano w punkcie 3, instalacja wodna" });
    const plan = await insertPage(projectId, documentId, 16, { searchText: "Rzut parteru, instalacja wodna" });
    const upstairs = await insertPage(projectId, documentId, 17, { searchText: "Rzut piętra, instalacja wodna" });
    await setMeta(description, { kind: "opis" });
    await setMeta(plan, { kind: "rysunek", branch: "instalacje", level: "parter" });
    await setMeta(upstairs, { kind: "detal", branch: "instalacje", level: "piętro 1" });

    const pages = async (filter: Parameters<typeof searchPages>[3]) =>
      (await searchPages(projectId, "instalacja wodna", 6, filter)).map((hit) => hit.pageNo).sort((a, b) => a - b);

    expect(await pages({})).toEqual([4, 16, 17]);
    expect(await pages({ kind: "rysunek" })).toEqual([16, 17]);
    expect(await pages({ kind: "opis" })).toEqual([4]);
    expect(await pages({ branch: "instalacje", level: "przyziemie" })).toEqual([16]);
    expect(await pages({ level: "I piętro" })).toEqual([17]);
  });

  it("fills in metadata of pages indexed before it existed at startup", async () => {
    const pageId = await insertPage(projectId, documentId, 18, {
      title: "BIALINVES",
      searchText: "RYSUNEK:\nRZUT DACHU\nOBIEKT:\nHala\nDATA:   SKALA:   NR RYS.:\n2023    1:100    5.",
    });

    await migrate();

    const [page] = await sql`select kind, title, drawing_no, scale, level from pages where id = ${pageId}`;
    expect(page).toEqual({ kind: "rysunek", title: "RZUT DACHU (rys. 5)", drawing_no: "5", scale: "1:100", level: "dach" });
  });
});

describe("searchPages with parameters from the text (#53)", () => {
  let projectId: string;
  let documentId: string;

  beforeEach(async () => {
    await resetDatabase();
    config.openrouterApiKey = "";
    projectId = await createProject();
    documentId = await createDocument(projectId, "ready");
  });

  it("finds a page by a parameter's name and returns the matching parameters with it", async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `Wiersz ${i} opisu robót przygotowawczych`).join("\n");
    await insertPage(projectId, documentId, 8, {
      searchText: `${filler}\nOcieplenie cokołu wykonać z płyt izolacyjnych – styrodur gr. 10 cm.\nTynk mozaikowy na wysokość 30 cm.`,
    });
    await insertPage(projectId, documentId, 3, { searchText: "Kubatura budynku – 6680 m3" });
    await migrate();

    const [hit] = await searchPages(projectId, "Jaka grubość styroduru?");

    expect(hit).toMatchObject({ pageNo: 8, facts: [{ label: "wykonać z płyt izolacyjnych – styrodur", value: "10 cm" }] });
  });

  it("re-reads the parameters of pages stored with an older extraction at startup", async () => {
    const pageId = await insertPage(projectId, documentId, 3, { searchText: "Kubatura budynku – 6680 m3" });
    await migrate();
    await sql`update pages set facts_version = 0 where id = ${pageId}`;
    await sql`delete from facts where page_id = ${pageId}`;

    await migrate();

    const facts = await sql`select label, value, unit, tenant_id is not null as tenant from facts where page_id = ${pageId}`;
    expect(facts).toEqual([{ label: "Kubatura budynku", value: "6680", unit: "m3", tenant: true }]);
    const [page] = await sql`select facts from pages where id = ${pageId}`;
    expect(page!.facts).toEqual([{ label: "Kubatura budynku", value: "6680 m3" }]);
  });
});

describe("searchPages in a large project (#58)", () => {
  let projectId: string;
  let documentId: string;

  beforeEach(async () => {
    await resetDatabase();
    embed.mockReset();
    config.openrouterApiKey = "test-key";
    config.searchIndexedFromPages = 0;
    projectId = await createProject();
    documentId = await createDocument(projectId, "ready");
    await sql`update documents set page_count = 5000 where id = ${documentId}`;
  });

  afterAll(() => {
    config.searchIndexedFromPages = 1000;
  });

  it("finds the same pages through the HNSW index and the full-text index", async () => {
    const pages: string[] = [];
    for (let pageNo = 1; pageNo <= 30; pageNo++) {
      pages.push(await insertPage(projectId, documentId, pageNo, { searchText: pageNo === 7 ? "Okna PCV trzyszybowe" : `Rzut ${pageNo}` }));
    }
    for (const [i, pageId] of pages.entries()) {
      await sql`insert into chunks (page_id, project_id, content, embedding, embedding_set)
        values (${pageId}, ${projectId}, 'fragment', ${`[${axisVector(i === 19 ? 0 : 1 + (i % 5)).join(",")}]`}::vector, ${ACTIVE_SET})`;
    }
    embed.mockResolvedValue([axisVector(0)]);

    const semantic = await semanticSearch(projectId, "attyka", 3);
    const lexical = await lexicalSearch(projectId, "okna", 3);

    expect(semantic[0]).toMatchObject({ page_id: pages[19], distance: 0 });
    expect(lexical.map((row) => row.page_id)).toEqual([pages[6]]);
    expect((await searchPages(projectId, "okna", 2)).map((hit) => hit.pageNo).sort((a, b) => a - b)).toEqual([7, 20]);
  });
});
