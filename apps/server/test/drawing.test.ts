import { readdir, stat } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "../src/db.js";
import { inspectionImages, isLargeSheet, planTiles } from "../src/drawing.js";
import { MAX_JPEG_BYTES } from "../src/pdf.js";
import { pageTilesDir } from "../src/storage.js";
import { createDocument, createProject, makePdf, resetDatabase, writeDocumentPdf } from "./helpers.js";

const A4 = { width: 595, height: 842 };
const A1 = { width: 1684, height: 2384 };
const A0 = { width: 2384, height: 3370 };
const A0_LANDSCAPE = { width: 3370, height: 2384 };

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await sql.end();
});

describe("planTiles", () => {
  it("tiles only sheets bigger than A3", () => {
    expect(isLargeSheet(A4)).toBe(false);
    expect(isLargeSheet({ width: 842, height: 1191 })).toBe(false);
    expect(isLargeSheet(A1)).toBe(true);
  });

  it.each([
    ["A1", A1],
    ["A0", A0],
    ["A0 poziomo", A0_LANDSCAPE],
  ])("covers a whole %s sheet with at most 9 overlapping tiles at a readable resolution", (_name, size) => {
    const tiles = planTiles(size);
    const dpi = tiles[0]!.dpi;
    const width = Math.ceil((size.width / 72) * dpi);
    const height = Math.ceil((size.height / 72) * dpi);

    expect(tiles.length).toBeLessThanOrEqual(9);
    expect(dpi).toBeGreaterThanOrEqual(100);
    expect(Math.max(...tiles.map((t) => t.x + t.width))).toBe(width);
    expect(Math.max(...tiles.map((t) => t.y + t.height))).toBe(height);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(Math.max(tile.width, tile.height)).toBeLessThanOrEqual(2200);
    }
    // Neighbouring tiles overlap, so nothing on a seam is cut in half in every tile.
    const [first, second] = tiles;
    if (second && second.row === first!.row) expect(second.x).toBeLessThan(first!.x + first!.width);
  });
});

describe("inspectionImages", () => {
  it("renders an A1 sheet as the page plus cached zoomed tiles, each under the JPEG size limit", async () => {
    const projectId = await createProject();
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(["Rzut przyziemia 1:50"], A1));

    const images = await inspectionImages(documentId, 1);

    expect(images.length).toBe(1 + planTiles(A1).length);
    for (const image of images) expect((await stat(image)).size).toBeLessThanOrEqual(MAX_JPEG_BYTES);
    const rendered = await readdir(await pageTilesDir(documentId, 1));
    expect(await inspectionImages(documentId, 1)).toEqual(images);
    expect(await readdir(await pageTilesDir(documentId, 1))).toEqual(rendered);
  });

  it("sends just the page image for an ordinary A4 page", async () => {
    const projectId = await createProject();
    const documentId = await createDocument(projectId);
    await writeDocumentPdf(documentId, makePdf(["Opis techniczny"], A4));

    expect(await inspectionImages(documentId, 1)).toHaveLength(1);
  });
});
