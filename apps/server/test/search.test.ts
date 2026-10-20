import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { prefixQuery, searchPages } from "../src/search.js";
import { axisVector, createDocument, createProject, insertPage, resetDatabase } from "./helpers.js";

const embed = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());
vi.mock("../src/llm.js", () => ({ embed }));

describe("prefixQuery", () => {
  it("turns each word into a prefix of its stem-ish head", () => {
    expect(prefixQuery("Grubość ocieplenia ścian")).toBe("grubo:* | ocieple:* | ścia:*");
  });

  it("keeps at least four letters and drops words shorter than three", () => {
    expect(prefixQuery("tynk na ścianie")).toBe("tynk:* | ścian:*");
  });

  it("splits on punctuation and keeps numbers", () => {
    expect(prefixQuery("rys. nr 4, XPS-300")).toBe("rys:* | xps:* | 300:*");
  });

  it("returns an empty query when no word is long enough", () => {
    expect(prefixQuery("a i w")).toBe("");
  });
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

  afterAll(async () => {
    config.openrouterApiKey = "";
    await sql.end();
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
    const lexicalPage = await insertPage(projectId, documentId, 2, { searchText: "Zestawienie stolarki okiennej" });
    const semanticPage = await insertPage(projectId, documentId, 9, { searchText: "Detal attyki" });
    await sql`insert into chunks (page_id, project_id, content, embedding) values
      (${semanticPage}, ${projectId}, 'attyka', ${`[${axisVector(0).join(",")}]`}::vector),
      (${lexicalPage}, ${projectId}, 'okna', ${`[${axisVector(1).join(",")}]`}::vector)`;
    embed.mockResolvedValue([axisVector(0)]);

    const hits = await searchPages(projectId, "okna", 2);

    expect(embed).toHaveBeenCalledWith(["okna"]);
    expect(hits.map((hit) => hit.pageNo).sort()).toEqual([2, 9]);
  });

  it("ranks a page holding the exact code first, whichever way it is written", async () => {
    await insertPage(projectId, documentId, 3, { searchText: "Ściany docieplone, rury spustowe wymienione, norma do przemarzania gruntu" });
    await insertPage(projectId, documentId, 7, { searchText: "Głębokość przemarzania wg PN-81/B-03020, rynny ∅150, rury spustowe Ø120mm" });

    expect((await searchPages(projectId, "PN-81/B-03020"))[0]?.pageNo).toBe(7);
    expect((await searchPages(projectId, "rury spustowe Ø120"))[0]?.pageNo).toBe(7);
  });

  it("expands trade abbreviations in the query", async () => {
    await insertPage(projectId, documentId, 4, { searchText: "Ocieplenie ścian wełną mineralną gr. 15 cm" });
    await insertPage(projectId, documentId, 5, { searchText: "Tynk cienkowarstwowy na ścianach" });

    expect((await searchPages(projectId, "grubość MW"))[0]?.pageNo).toBe(4);
  });

  it("caps the number of results", async () => {
    for (let pageNo = 1; pageNo <= 5; pageNo++) {
      await insertPage(projectId, documentId, pageNo, { searchText: `Rzut kondygnacji ${pageNo}` });
    }

    expect(await searchPages(projectId, "rzut", 3)).toHaveLength(3);
  });
});
