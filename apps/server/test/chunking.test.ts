import { describe, expect, it } from "vitest";
import { chunkPage } from "../src/chunking.js";

const sentence = (n: number) => `Zdanie opisu numer ${n} o robotach ociepleniowych na ścianie.`;
const paragraph = (from: number, count: number) => Array.from({ length: count }, (_, i) => sentence(from + i)).join("\n");

describe("chunkPage", () => {
  it("keeps a short page in one fragment with the spaces of the layout collapsed", () => {
    expect(chunkPage("OPIS   TECHNICZNY\n  kubatura budynku –   6680 m3")).toEqual(["OPIS TECHNICZNY\nkubatura budynku – 6680 m3"]);
  });

  it("cuts between numbered sections instead of in the middle of one", () => {
    const raw = `2.5.1. Kolejność robót\n${paragraph(0, 8)}\n2.5.2. Mocowanie płyt\n${paragraph(100, 8)}`;
    const chunks = chunkPage(raw, 700);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.startsWith("2.5.1. Kolejność robót")).toBe(true);
    expect(chunks[1]!.startsWith("2.5.2. Mocowanie płyt")).toBe(true);
  });

  it("cuts a long table between rows and repeats its header in every fragment", () => {
    const header = "Symbol      Wymiary otworu      Ilość      Uwagi";
    const rows = Array.from({ length: 40 }, (_, i) => `O${i + 1}          84x142              ${i + 1}          PCV 3-szybowe`);
    const chunks = chunkPage([header, "", ...rows].join("\n"), 400);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.split("\n")[0]).toBe("Symbol | Wymiary otworu | Ilość | Uwagi");
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
    expect(chunks.join("\n")).toContain("O40 | 84x142 | 40 | PCV 3-szybowe");
  });

  it("still respects the limit for text without any structure", () => {
    const chunks = chunkPage("słowo ".repeat(1000), 500);

    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("returns nothing for an empty page", () => {
    expect(chunkPage(" \n\n")).toEqual([]);
  });
});
