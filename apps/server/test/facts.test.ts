import { describe, expect, it } from "vitest";
import { extractFacts, formatFact } from "../src/facts.js";

const short = (raw: string) => extractFacts(raw).map(({ label, value, unit }) => ({ label, value, unit }));

describe("extractFacts", () => {
  it("reads a value with its unit and the words naming it", () => {
    expect(short("a) kubatura budynku – 6680 m3\n - powierzchnia zabudowy budynku – 787,06 m2")).toEqual([
      { label: "kubatura budynku", value: "6680", unit: "m3" },
      { label: "powierzchnia zabudowy budynku", value: "787,06", unit: "m2" },
    ]);
  });

  it("drops filler words between the name and the value", () => {
    expect(short("Ocieplenie cokołu wykonać z płyt izolacyjnych – styrodur gr. 10 cm.")).toEqual([
      { label: "wykonać z płyt izolacyjnych – styrodur", value: "10", unit: "cm" },
    ]);
    expect(short("nachyleniu połaci dachowych pod kątem 24°.")[0]).toMatchObject({ label: "nachyleniu połaci dachowych", unit: "°" });
  });

  it("gives values listed together the same name and keeps diameters and sizes", () => {
    expect(short("płyty z wełny mineralnej o grubości 2cm i 5cm, rury spustowe Ø120mm, właz 80x80 cm")).toEqual([
      { label: "płyty z wełny mineralnej o grubości", value: "2", unit: "cm" },
      { label: "płyty z wełny mineralnej o grubości", value: "5", unit: "cm" },
      { label: "rury spustowe", value: "Ø120", unit: "mm" },
      { label: "właz", value: "80x80", unit: "cm" },
    ]);
  });

  it("reads thermal values and classes without a unit", () => {
    const facts = short("Okna - współczynnik U = 0,9 W/m2K. Strop z betonu klasy C25/30, wełna λD= 0,035 W/mK");
    expect(facts).toContainEqual({ label: "współczynnik U", value: "0,9", unit: "W/m2K" });
    expect(facts).toContainEqual({ label: "wełna λD", value: "0,035", unit: "W/mK" });
    expect(facts).toContainEqual({ label: "Strop z betonu klasy", value: "C25/30", unit: "" });
  });

  it("does not take a word after the number for a unit", () => {
    expect(short("w 3 miejscach, 12 mm2")).toEqual([]);
  });

  it("formats a value with its unit", () => {
    expect(formatFact({ value: "15", unit: "cm" })).toBe("15 cm");
    expect(formatFact({ value: "C25/30", unit: "" })).toBe("C25/30");
  });
});
