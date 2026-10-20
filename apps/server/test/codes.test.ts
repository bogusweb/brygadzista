import { describe, expect, it } from "vitest";
import { expandAbbreviations, extractCodes } from "../src/codes.js";

describe("extractCodes", () => {
  it("keeps sheet marks, classes and standards that full-text search splits apart", () => {
    expect(extractCodes("rys. A-04, beton C25/30 wg PN-81/B-03020")).toEqual(
      expect.arrayContaining(["a4", "rysa4", "c25/30", "pn81/b3020"]),
    );
  });

  it("writes variants of one mark the same way", () => {
    for (const variant of ["A-04", "A.04", "A04", "a–04", "A4"]) expect(extractCodes(variant)).toContain("a4");
    expect(extractCodes("Ø120")).toEqual(extractCodes("∅120"));
    expect(extractCodes("PRZEKRÓJ C­C")).toEqual(extractCodes("przekrój C-C"));
  });

  it("reads decimal commas, symbols and units", () => {
    expect(extractCodes("λD= 0,035 W/mK")).toEqual(expect.arrayContaining(["λd", "0.035"]));
    expect(extractCodes("rury Ø120mm")).toEqual(expect.arrayContaining(["ø120mm", "ø120"]));
    expect(extractCodes("styrodur gr. 15 cm")).toContain("15cm");
  });

  it("joins a capitalised mark with what follows it, as it is also written without the space", () => {
    expect(extractCodes("RAL 9006")).toContain("ral9006");
    expect(extractCodes("ZL IV")).toContain("zliv");
    expect(extractCodes("rys. nr 5")).toContain("rys5");
    expect(extractCodes("DETAL 3 – DOCIEPLENIE")).toContain("detal3");
  });

  it("skips ordinary words and short bare numbers", () => {
    expect(extractCodes("Jaka jest grubość 2 warstw ocieplenia na 3 ścianach?")).toEqual([]);
  });
});

describe("expandAbbreviations", () => {
  it("adds the spelled-out name of an abbreviation", () => {
    expect(expandAbbreviations("grubość MW na ścianach")).toBe("grubość MW na ścianach wełna mineralna");
  });

  it("leaves a query without abbreviations as it is", () => {
    expect(expandAbbreviations("kubatura budynku")).toBe("kubatura budynku");
  });
});
