import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { estimateIndexing, etaSeconds } from "../src/estimate.js";

afterEach(() => {
  config.openrouterApiKey = "";
});

describe("estimateIndexing", () => {
  it("prices vision indexing per page and spreads the time over the workers", () => {
    expect(estimateIndexing(300, true)).toEqual({
      pages: 300,
      vision: true,
      costUsd: Math.round(300 * config.indexCostPerPageUsd * 100) / 100,
      seconds: (300 / config.indexConcurrency) * config.indexSecondsPerPage,
    });
  });

  it("costs nothing without an API key, because only the PDF text is extracted", () => {
    expect(estimateIndexing(300)).toMatchObject({ vision: false, costUsd: 0 });
    config.openrouterApiKey = "test-key";
    expect(estimateIndexing(300).vision).toBe(true);
  });
});

describe("etaSeconds", () => {
  const now = Date.parse("2026-10-20T10:00:00Z");

  it("projects the pace so far onto the remaining pages", () => {
    const startedAt = new Date(now - 100_000);
    expect(etaSeconds({ total: 300, done: 50, startedAt }, now)).toBe(500);
  });

  it("falls back to the estimate before the first page is done", () => {
    config.openrouterApiKey = "test-key";
    expect(etaSeconds({ total: 10, done: 0, startedAt: new Date(now) }, now)).toBe(estimateIndexing(10).seconds);
  });

  it("is zero when nothing is left", () => {
    expect(etaSeconds({ total: 10, done: 10, startedAt: new Date(now - 1000) }, now)).toBe(0);
  });
});
