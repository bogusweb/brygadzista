import { describe, expect, it } from "vitest";
import { factLine, unseenRevisions } from "./revisions";
import type { Revision } from "./revisions";

const revision = (documentId: string): Revision => ({
  documentId,
  filename: "projekt-v2.pdf",
  previousId: "old",
  previousFilename: "projekt.pdf",
  createdAt: "2026-10-22T10:00:00Z",
  changedPages: 1,
  changes: [],
});

describe("unseenRevisions", () => {
  it("keeps only versions the crew has not opened", () => {
    expect(unseenRevisions([revision("a"), revision("b")], ["a"]).map((found) => found.documentId)).toEqual(["b"]);
    expect(unseenRevisions(null, null)).toEqual([]);
  });
});

describe("factLine", () => {
  it("says what the value was and is", () => {
    expect(factLine({ label: "styropian gr.", before: "12 cm", after: "15 cm" })).toBe("styropian gr.: było 12 cm, jest 15 cm");
    expect(factLine({ label: "wełna", before: null, after: "20 cm" })).toBe("wełna: dodano 20 cm");
    expect(factLine({ label: "papa", before: "1 szt.", after: null })).toBe("papa: usunięto 1 szt.");
  });
});
