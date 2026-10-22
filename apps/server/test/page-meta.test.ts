import { describe, expect, it } from "vitest";
import { canonicalDrawingNo, displayTitle, drawingRefOf, extractPageMeta, levelOf } from "../src/page-meta.js";

// Title blocks as pdftotext -layout prints them: the drawing on the left, the block in columns on the right.
const sheet = (title: string[], values: { scale: string; number: string }) =>
  [
    "  Rynna Ø150       0,5%                                BIALINVEST Obsługa Inwestycji",
    "  24°=44%                                              PROJEKT TECHNICZNY",
    "  Rura spustowa Ø120                                   RYSUNEK:",
    ...title.map((line) => `  wywietrzak                                              ${line}`),
    "                                                       OBIEKT:",
    "                                                          Obiekt sportowy - Pilawa",
    "                                                       SPECJALNOŚĆ  ARCHITEKTONICZNA",
    "                                                       DATA:            SKALA:      NR RYS.:",
    `                                                       czerwiec 2023    ${values.scale}       ${values.number}`,
  ].join("\n");

describe("extractPageMeta", () => {
  it("reads the title, number and scale from a drawing's title block", () => {
    expect(extractPageMeta(sheet(["RZUT DACHU"], { scale: "1:100", number: "5." }), 18)).toEqual({
      kind: "rysunek",
      title: "RZUT DACHU",
      drawingNo: "5",
      scale: "1:100",
      revision: null,
      branch: "architektura",
      level: "dach",
    });
  });

  it("joins a title over several lines and tells details, schedules and trades apart", () => {
    const detail = extractPageMeta(sheet(["DETAL 2 - SPOSÓB KLEJENIA IZOLACJI", "TERMICZNEJ - NAROŻE"], { scale: "1:10", number: "16." }), 29);
    expect(detail).toMatchObject({ kind: "detal", title: "DETAL 2 – SPOSÓB KLEJENIA IZOLACJI TERMICZNEJ – NAROŻE", drawingNo: "16" });
    expect(extractPageMeta(sheet(["ZESTAWIENIE STOLARKI"], { scale: "1:50", number: "14." }), 27).kind).toBe("zestawienie");
    expect(extractPageMeta(sheet(["INSTALACJA WOD-KAN - RZUT PARTERU"], { scale: "1:50", number: "S-01" }), 30)).toMatchObject({
      branch: "instalacje",
      level: "parter",
      drawingNo: "s1",
    });
    expect(extractPageMeta(sheet(["RZUT FUNDAMENTÓW"], { scale: "1:50", number: "K-1" }), 31).branch).toBe("konstrukcja");
  });

  it("reads a title block written as label and value on one line", () => {
    const raw = "Rysunek: Rzut I piętra\nSkala: 1:50    Rewizja: B\nNr rys.: A-04";
    expect(extractPageMeta(raw, 9)).toMatchObject({
      kind: "rysunek",
      title: "Rzut I piętra",
      drawingNo: "a4",
      scale: "1:50",
      revision: "B",
      level: "piętro 1",
    });
  });

  it("does not take a table of contents for the drawings it lists", () => {
    const raw = "                  SPIS ZAWARTOŚCI PROJEKTU:\nRZUT DACHU              – rys. nr 5    str. 17\nELEWACJA POŁUDNIOWA     – rys. nr 6    str. 18";
    expect(extractPageMeta(raw, 2)).toMatchObject({ kind: "formalne", drawingNo: null, title: null });
  });

  it("calls a long page of text a description and the first page the title page", () => {
    const text = "2.5. Wykonanie ociepleń.\n" + "Płyty izolacji mocowane są do podłoża za pomocą zaprawy klejowej. ".repeat(20);
    expect(extractPageMeta(text, 9)).toMatchObject({ kind: "opis", branch: null, level: null });
    expect(extractPageMeta(text, 1).kind).toBe("formalne");
    expect(extractPageMeta("", 40).kind).toBeNull();
  });
});

describe("drawing numbers", () => {
  it("finds the drawing number a question names, written any way", () => {
    expect(drawingRefOf("Co jest na rys. nr 5?")).toBe("5");
    expect(drawingRefOf("pokaż rysunek 12")).toBe("12");
    expect(drawingRefOf("nr rys. A-04")).toBe("a4");
    expect(drawingRefOf("jaka grubość styropianu")).toBeNull();
    expect(drawingRefOf("rysunek elewacji")).toBeNull();
  });

  it("writes a number one way", () => {
    expect(canonicalDrawingNo("A-04")).toBe("a4");
    expect(canonicalDrawingNo("5.")).toBe("5");
    expect(canonicalDrawingNo("05")).toBe("5");
  });

  it("shows a drawing's own name with its number as the page title", () => {
    const meta = extractPageMeta(sheet(["RZUT DACHU"], { scale: "1:100", number: "5." }), 18);
    expect(displayTitle(meta, "BIALINVES")).toBe("RZUT DACHU (rys. 5)");
    expect(displayTitle({ ...meta, title: null }, "OPIS TECHNICZNY")).toBe("OPIS TECHNICZNY");
  });
});

describe("levelOf", () => {
  it("names each storey one way", () => {
    expect(levelOf("RZUT PRZYZIEMIA")).toBe("parter");
    expect(levelOf("Rzut piwnic")).toBe("piwnica");
    expect(levelOf("RZUT II PIĘTRA")).toBe("piętro 2");
    expect(levelOf("rzut piętra 1")).toBe("piętro 1");
    expect(levelOf("Rzut poddasza")).toBe("poddasze");
    expect(levelOf("ELEWACJA PÓŁNOCNA")).toBeNull();
  });
});
