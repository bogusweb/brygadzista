import { describe, expect, it } from "vitest";
import { createSearcher, drawingCodes, foldText, queryTerms } from "./search";
import type { IndexedPage } from "./search";

const page = (pageNo: number, fields: Partial<IndexedPage>): IndexedPage => ({
  documentId: "doc",
  filename: "projekt.pdf",
  pageNo,
  title: null,
  kind: null,
  summary: null,
  keywords: [],
  text: "",
  ...fields,
});

const PAGES = [
  page(3, {
    title: "Opis techniczny – przegrody zewnętrzne",
    summary: "Ocieplenie ścian styropianem grafitowym.",
    text: "Ściany zewnętrzne ocieplić płytami styropianu grafitowego gr. 15 cm. Tynk silikonowy.",
  }),
  page(12, { title: "Rzut parteru", keywords: ["rzut", "A-02"], text: "Rys. A-02 Rzut parteru. Sala gimnastyczna, szatnie." }),
  page(18, {
    title: "Detal D-3 – cokół",
    keywords: ["cokół", "XPS"],
    text: "Detal D-3. Cokół ocieplić płytami XPS gr. 12 cm na wysokość 50 cm ponad poziom terenu.",
  }),
  page(20, { title: "Rzut dachu", text: "Rys. A-04 rzut dachu, spadki 3%, wpusty dachowe." }),
];

const search = createSearcher({ generatedAt: "2026-10-20T00:00:00Z", pages: PAGES });
const pageNos = (query: string) => search(query).map((hit) => hit.page.pageNo);

describe("foldText", () => {
  it("drops Polish letters so a query typed without them still matches", () => {
    expect(foldText("Cokół, Łącznik ŹRÓDŁO")).toBe("cokol, lacznik zrodlo");
  });
});

describe("drawingCodes", () => {
  it("reads marks the same way whatever the separator or zero padding", () => {
    expect([...drawingCodes(foldText("rys. A-04, A04, a.4 i D-3"))].sort()).toEqual(["a4", "d3"]);
  });

  it("does not take a word and a number separated by a space for a mark", () => {
    expect(drawingCodes(foldText("do 50 cm"))).toEqual(new Set());
  });
});

describe("queryTerms", () => {
  it("shortens words like the server and keeps marks apart", () => {
    expect(queryTerms("ocieplenia rys. A-04")).toEqual({ stems: ["ocieple", "rys"], codes: ["a4"] });
  });
});

describe("createSearcher", () => {
  it("finds pages through other forms of a word", () => {
    expect(pageNos("ocieplenia")).toEqual([3]);
    expect(pageNos("styropianem")).toEqual([3]);
    expect(pageNos("cokołu")).toEqual([18]);
  });

  it("matches without Polish letters", () => {
    expect(pageNos("cokol")).toEqual([18]);
  });

  it("finds a drawing by its mark and puts the exact mark first", () => {
    expect(pageNos("A-04")).toEqual([20]);
    expect(pageNos("rys. a04")).toEqual([20]);
    expect(pageNos("rys. A-99")).toEqual([12, 20]);
    expect(pageNos("detal D3")[0]).toBe(18);
  });

  it("ranks the page with every word of the question above pages with one", () => {
    expect(pageNos("rzut dachu")[0]).toBe(20);
    expect(pageNos("rzut parteru")[0]).toBe(12);
  });

  it("returns nothing for an empty or too short question", () => {
    expect(search("")).toEqual([]);
    expect(search("a")).toEqual([]);
  });

  it("shows the text around the match", () => {
    const [hit] = search("wysokość");
    expect(hit!.page.pageNo).toBe(18);
    expect(hit!.snippet).toContain("na wysokość 50 cm");
  });
});
