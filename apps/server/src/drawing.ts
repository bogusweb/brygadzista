import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pdfPageSize, pdfRenderPage, pdfRenderRegion } from "./pdf.js";
import { documentPdf, pageImage, pageImagePrefix, pageTilesDir } from "./storage.js";

const POINTS_PER_INCH = 72;
// Anything up to A3 reads fine from the 2200 px page image; A2, A1 and A0 sheets get tiled.
const A3_AREA = 842 * 1191;
const LARGE_SHEET_AREA = A3_AREA * 1.2;
// 150 DPI keeps 2 mm dimension text on a 1:50 drawing legible.
const TARGET_DPI = 150;
const MIN_DPI = 72;
const TILE_PX = 1800;
const MAX_TILES = 9;
const OVERLAP = 0.06;

export type Tile = { row: number; col: number; dpi: number; x: number; y: number; width: number; height: number };

export const isLargeSheet = (size: { width: number; height: number }) => size.width * size.height > LARGE_SHEET_AREA;

// Highest DPI (up to TARGET_DPI) at which the sheet splits into at most MAX_TILES tiles of about TILE_PX,
// each tile overlapping its neighbours so a dimension on a seam shows whole in one of them.
export const planTiles = (size: { width: number; height: number }): Tile[] => {
  let dpi = TARGET_DPI;
  const grid = (d: number) => {
    const width = Math.ceil((size.width / POINTS_PER_INCH) * d);
    const height = Math.ceil((size.height / POINTS_PER_INCH) * d);
    return { width, height, cols: Math.ceil(width / TILE_PX), rows: Math.ceil(height / TILE_PX) };
  };
  while (dpi > MIN_DPI && grid(dpi).cols * grid(dpi).rows > MAX_TILES) dpi = Math.max(MIN_DPI, Math.floor(dpi * 0.95));
  const { width, height, cols, rows } = grid(dpi);
  const tileWidth = Math.ceil(width / cols);
  const tileHeight = Math.ceil(height / rows);
  const padX = Math.round(tileWidth * OVERLAP);
  const padY = Math.round(tileHeight * OVERLAP);
  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.max(0, col * tileWidth - padX);
      const y = Math.max(0, row * tileHeight - padY);
      tiles.push({
        row,
        col,
        dpi,
        x,
        y,
        width: Math.min(width, (col + 1) * tileWidth + padX) - x,
        height: Math.min(height, (row + 1) * tileHeight + padY) - y,
      });
    }
  }
  return tiles;
};

const readManifest = (file: string) =>
  readFile(file, "utf8").then(
    (text) => JSON.parse(text) as string[],
    () => null,
  );

// Images for inspect_drawing: the page itself, plus zoomed tiles when it is a large sheet.
// Tiles are rendered on first use and cached next to the page image.
export const inspectionImages = async (documentId: string, pageNo: number): Promise<string[]> => {
  const pdf = documentPdf(documentId);
  const overview = await access(pageImage(documentId, pageNo)).then(
    () => pageImage(documentId, pageNo),
    () => pdfRenderPage(pdf, pageNo, pageImagePrefix(documentId, pageNo)),
  );
  const dir = pageTilesDir(documentId, pageNo);
  const manifest = path.join(dir, "tiles.json");
  const cached = await readManifest(manifest);
  if (cached) return [overview, ...cached];

  const size = await pdfPageSize(pdf, pageNo);
  const tiles: string[] = [];
  await mkdir(dir, { recursive: true });
  if (isLargeSheet(size)) {
    for (const tile of planTiles(size)) tiles.push(await pdfRenderRegion(pdf, pageNo, path.join(dir, `r${tile.row}c${tile.col}`), tile));
  }
  await writeFile(manifest, JSON.stringify(tiles));
  return [overview, ...tiles];
};
