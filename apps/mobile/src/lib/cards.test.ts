import { describe, expect, it } from "vitest";
import { cardPages, layerLine, withCard } from "./cards";
import type { ElementCard } from "./cards";

const source = (pageNo: number) => ({ documentId: "d1", pageNo, quote: null, imagePath: `/api/documents/d1/pages/${pageNo}/image` });

const card = (fields: Partial<ElementCard>): ElementCard => ({
  id: "c1",
  projectId: "p1",
  kind: "room",
  name: "Łazienka 1.04",
  status: "ready",
  error: null,
  fields: [],
  layers: [],
  missing: [],
  createdBy: "Jan",
  createdAt: "2026-10-22T10:00:00Z",
  generatedAt: "2026-10-22T10:00:05Z",
  ...fields,
});

describe("withCard", () => {
  it("adds a new card in order and replaces an older copy of the same card", () => {
    const wall = card({ id: "c2", kind: "partition", name: "Ściana SZ1" });
    const kitchen = card({ id: "c3", name: "Kuchnia 1.02" });
    const saved = withCard(withCard(null, wall), card({}));

    expect(withCard(saved, kitchen).map((item) => item.id)).toEqual(["c3", "c1", "c2"]);
    expect(withCard(saved, card({ status: "error" })).filter((item) => item.id === "c1")).toEqual([card({ status: "error" })]);
  });
});

describe("cardPages", () => {
  it("lists every cited page once", () => {
    const wall = card({
      fields: [
        { key: "u", label: "U", value: "0,18", status: "found", source: source(6) },
        { key: "thickness", label: "Grubość", value: null, status: "to_confirm", source: null },
      ],
      layers: [{ material: "wełna", thickness: "15 cm", status: "found", source: source(6) }, { material: "bloczek", thickness: null, status: "found", source: source(8) }],
    });

    expect(cardPages(wall)).toEqual([{ documentId: "d1", pageNo: 6 }, { documentId: "d1", pageNo: 8 }]);
  });
});

describe("layerLine", () => {
  it("shows the thickness only when the project gives it", () => {
    expect(layerLine({ material: "wełna mineralna", thickness: "15 cm", status: "found", source: null })).toBe("wełna mineralna – 15 cm");
    expect(layerLine({ material: "tynk", thickness: null, status: "found", source: null })).toBe("tynk");
  });
});
