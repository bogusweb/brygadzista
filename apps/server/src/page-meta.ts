import { titleFromText } from "./outline.js";

export { titleFromText };

// Page metadata read from the PDF text without a model (#55): the drawing's title block (title, number, scale,
// revision), the kind of page, the trade and the storey. Search filters on these, and a question naming a drawing
// number ("rys. nr 5") goes straight to the sheet that carries it instead of the table of contents that lists it.

export const PAGE_KINDS = ["opis", "rysunek", "detal", "zestawienie", "formalne", "inne"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const PAGE_BRANCHES = ["architektura", "konstrukcja", "instalacje"] as const;
export type PageBranch = (typeof PAGE_BRANCHES)[number];

export type PageMeta = {
  kind: PageKind | null;
  title: string | null;
  drawingNo: string | null;
  scale: string | null;
  revision: string | null;
  branch: PageBranch | null;
  level: string | null;
};

// Bump when extraction changes: pages with an older version get their metadata again from stored text at startup.
export const META_VERSION = 1;

const TITLE_CHARS = 120;
const TITLE_LINES = 4;

// A description page has paragraphs; a sheet with less text than this and no title block is something else.
const DESCRIPTION_CHARS = 800;
const HEADING_LINES = 8;

// Labels of a title block field: "RYSUNEK:", "NR RYS.:", "SKALA:". Each line of the block is "LABEL: value" or a row
// of labels with the values on the next line in the same columns (pdftotext -layout keeps the columns).
const TITLE_LABEL = /^(?:RYSUNEK|TYTUŁ RYSUNKU|NAZWA RYSUNKU|TEMAT)\s*:?\s*$/iu;
const TITLE_LABEL_INLINE = /^(?:RYSUNEK|TYTUŁ RYSUNKU|NAZWA RYSUNKU)\s*:\s*(.+)$/iu;
const NEXT_LABEL = /^[\p{Lu} .]{3,30}:/u;
const NUMBER_LABEL = /(?:NR\s+RYS(?:UNKU)?\.?|NUMER\s+RYSUNKU|RYS(?:UNEK)?\.?\s+NR)\s*:?/iu;
const SCALE_LABEL = /SKALA\s*:?/iu;
const REVISION_LABEL = /(?:REWIZJA|REW\.|WERSJA)\s*:?/iu;

// How far a value may sit from its label's column in a layout line below it.
const COLUMN_SLACK = 20;
const DRAWING_NO = /^[\p{L}]{0,3}[-.]?\d{1,3}[\p{L}]?\.?$/u;
const SCALE = /^1\s*:\s*\d{1,4}$/;
const REVISION = /^[A-Z0-9]{1,3}$/;

// One spelling for a drawing number on both sides: "A-04", "A.04" and "a4" are one sheet, "5." is "5".
export const canonicalDrawingNo = (value: string) =>
  value
    .toLowerCase()
    .replace(/[-.\s]/g, "")
    .replace(/(?<=\p{L})0+(?=\d)/gu, "")
    .replace(/^0+(?=\d)/, "");

const cleanLine = (line: string) => line.replace(/­/g, "-").replace(/\s+/g, " ").trim();

// Cells of a layout line with their starting column, split on runs of two or more spaces.
const cells = (line: string) => {
  const found: { text: string; column: number }[] = [];
  for (const match of line.matchAll(/\S+(?: \S+)*/g)) found.push({ text: match[0], column: match.index });
  return found;
};

// The value of a labelled field: after the label on the same line, else the cell of the next line in the label's column.
const fieldValue = (lines: string[], label: RegExp, accept: RegExp) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const match = label.exec(line);
    if (!match) continue;
    const after = line.slice(match.index + match[0].length).trim().split(/\s{2,}/)[0]?.trim();
    if (after && accept.test(after)) return after;
    const below = lines[i + 1];
    if (!below) continue;
    const nearest = cells(below)
      .map((cell) => ({ ...cell, offset: Math.abs(cell.column - match.index) }))
      .sort((a, b) => a.offset - b.offset)[0];
    if (nearest && nearest.offset <= COLUMN_SLACK && accept.test(nearest.text.trim())) return nearest.text.trim();
  }
  return null;
};

// Text printed in the title block's frame, not part of the drawing's name.
const BLOCK_TEXT = /^(?:PROJEKT (?:TECHNICZNY|BUDOWLANY|WYKONAWCZY)|STADIUM|BRANŻA)\b/iu;
const TITLE_RIGHT_SLACK = 2;

// The drawing's title from its title block: the cells under "RYSUNEK:" (in its column or to the right of it, since
// layout lines also carry the drawing itself on the left) up to the next label, at most three lines.
const drawingTitle = (lines: string[]) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const label = cells(lines[i]!).find((cell) => TITLE_LABEL.test(cell.text) || TITLE_LABEL_INLINE.test(cell.text));
    if (!label) continue;
    const inline = TITLE_LABEL_INLINE.exec(cleanLine(label.text));
    if (inline && !NEXT_LABEL.test(inline[1]!)) return inline[1]!.slice(0, TITLE_CHARS);
    const parts: string[] = [];
    for (const next of lines.slice(i + 1, i + 1 + TITLE_LINES)) {
      const text = cleanLine(
        cells(next)
          .filter((cell) => cell.column >= label.column - TITLE_RIGHT_SLACK)
          .map((cell) => cell.text)
          .join(" "),
      );
      if (!text) {
        if (parts.length) break;
        continue;
      }
      if (BLOCK_TEXT.test(text)) continue;
      if (NEXT_LABEL.test(text)) break;
      parts.push(text);
    }
    if (parts.length) return parts.join(" ").replace(/\s+-\s+/g, " – ").slice(0, TITLE_CHARS);
  }
  return null;
};

const FORMAL = /SPIS ZAWARTOŚCI|SPIS TREŚCI|STRONA TYTUŁOWA|ZAŚWIADCZENIE|OŚWIADCZENIE|UPRAWNIENIA BUDOWLANE|KARTA TYTUŁOWA/iu;

const kindOf = (pageNo: number, title: string | null, isDrawing: boolean, heading: string, textLength: number): PageKind | null => {
  if (textLength === 0) return null;
  const name = title ?? heading;
  if (FORMAL.test(heading)) return "formalne";
  if (/ZESTAWIENIE|WYKAZ/iu.test(name)) return "zestawienie";
  if (isDrawing) return /^(?:DETAL|SZCZEGÓŁ|WĘZEŁ)\b/iu.test(title ?? "") ? "detal" : "rysunek";
  // The first page that is not a drawing is the title page, however much text it has.
  if (pageNo === 1) return "formalne";
  return textLength >= DESCRIPTION_CHARS ? "opis" : "inne";
};

const BRANCH_RULES: [PageBranch, RegExp][] = [
  ["instalacje", /INSTALAC|WOD\.?\s*-?\s*KAN|KANALIZAC|ELEKTRY|WENTYLAC|KLIMATYZAC|OGRZEWAN|\bC\.\s?O\.|GAZOW|ODGROMOW|SANITARN/iu],
  ["konstrukcja", /KONSTRUKC|ZBROJENI|FUNDAMENT|STROP|WIEŃC|BELK|SŁUP|NADPROŻ|WIĘŹB|STATYK/iu],
];

// The trade from the drawing's title. Drawings without a trade word are architectural: plans, elevations, sections
// and details. A description page mixes trades, so it gets none.
const branchOf = (kind: PageKind | null, name: string): PageBranch | null => {
  if (kind !== "rysunek" && kind !== "detal" && kind !== "zestawienie") return null;
  const rule = BRANCH_RULES.find(([, pattern]) => pattern.test(name));
  return rule ? rule[0] : "architektura";
};

const ORDINALS: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, pierwsz: 1, drugi: 2, drugie: 2, trzeci: 3, trzecie: 3 };

// The storey a plan shows, one spelling per storey: "RZUT PRZYZIEMIA" and "RZUT PARTERU" are both "parter".
export const levelOf = (name: string): string | null => {
  const text = name.toLowerCase();
  if (/piwnic|podziem/u.test(text)) return "piwnica";
  if (/przyziem|parter/u.test(text)) return "parter";
  if (/poddasz/u.test(text)) return "poddasze";
  const floor = /(?:\b([ivx]+|\d+)\.?\s*piętr|piętr\p{L}*\s+([ivx]+|\d+)\b|(pierwsz|drugie?|trzecie?)\p{L}*\s+piętr)/u.exec(text);
  if (floor) {
    const token = (floor[1] ?? floor[2] ?? floor[3])!;
    const number = /^\d+$/.test(token) ? Number(token) : ORDINALS[token];
    return number ? `piętro ${number}` : "piętro";
  }
  if (/piętr/u.test(text)) return "piętro";
  if (/\bdach|\bdachu\b/u.test(text)) return "dach";
  if (/fundament/u.test(text)) return "fundamenty";
  return null;
};

export const extractPageMeta = (raw: string, pageNo: number): PageMeta => {
  const lines = raw.split("\n");
  const title = drawingTitle(lines);
  const drawingNo = fieldValue(lines, NUMBER_LABEL, DRAWING_NO);
  const scale = fieldValue(lines, SCALE_LABEL, SCALE);
  const revision = fieldValue(lines, REVISION_LABEL, REVISION);
  const heading = lines.map(cleanLine).filter(Boolean).slice(0, HEADING_LINES).join(" ");
  const kind = kindOf(pageNo, title, title !== null || drawingNo !== null, heading, raw.trim().length);
  const isDrawing = kind === "rysunek" || kind === "detal" || kind === "zestawienie";
  const name = title ?? heading;
  // A table of contents lists every drawing number but is none of them.
  return {
    kind,
    title: isDrawing ? title : null,
    drawingNo: isDrawing && drawingNo ? canonicalDrawingNo(drawingNo) : null,
    scale: isDrawing && scale ? scale.replace(/\s/g, "") : null,
    revision: isDrawing ? revision : null,
    branch: branchOf(kind, name),
    level: isDrawing && title ? levelOf(title) : null,
  };
};

// The drawing number a question asks for: "rys. nr 5", "rysunek 5", "nr rys. A-04". Null when it names none.
export const drawingRefOf = (query: string): string | null => {
  const match = /(?:\brys(?:unek|unku|unkiem|\.)?|\bnr\s+rys(?:unku|\.)?)\s*(?:nr\.?\s*)?([\p{L}]{0,2}[-.]?\d{1,3}[\p{L}]?)(?![\p{L}\d])/iu.exec(query);
  return match ? canonicalDrawingNo(match[1]!) : null;
};

// Title shown for the page: a drawing's own name with its number, so "Źródło: str. 18 – RZUT DACHU (rys. 5)".
export const displayTitle = (meta: PageMeta, fallback: string | null) => {
  if (!meta.title) return fallback;
  return meta.drawingNo ? `${meta.title} (rys. ${meta.drawingNo})`.slice(0, TITLE_CHARS + 12) : meta.title;
};
