// Table of contents of a project PDF (#44): sections with page ranges, built from the text of its pages.
// A design project usually lists its parts on a contents page ("RZUT DACHU – rys. nr 5 str. 17"), but the listed
// numbers often drift from the PDF (a statement inserted in the middle shifts every drawing by one), so each entry is
// checked against the title block of the drawings ("RYSUNEK: RZUT DACHU") and the headings of the text pages.

export const OUTLINE_VERSION = 1;

export type SheetKind = "opis" | "rzut" | "przekroj" | "elewacja" | "detal" | "zestawienie";

export type OutlineSection = {
  title: string;
  from: number;
  to: number;
  kind?: SheetKind;
  drawingNo?: string;
  // Pages printed in the contents, when they differ from where the part really is in the PDF.
  declared?: { from: number; to: number };
  // False when the pages were inferred from neighbouring entries instead of found on the page itself.
  verified: boolean;
  // True for pages the contents does not list (a statement inserted later, scans).
  extra?: true;
  children?: OutlineSection[];
};

export type DocumentOutline = { version: number; source: "toc" | "pages"; tocPage?: number; sections: OutlineSection[] };

export type PageText = { pageNo: number; text: string };

const TITLE_CHARS = 120;

const HEADING_SEARCH_LINES = 30;

const collapse = (line: string) => line.replace(/[\s­]+/g, " ").trim();

// Without a reading model the title comes from the PDF text: the first heading in capitals near the top
// (e.g. "IV. OGÓLNA CHARAKTERYSTYKA BUDYNKU"), else the first line.
const isHeading = (line: string) => {
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toLocaleUpperCase("pl") && line.length <= TITLE_CHARS;
};

export const titleFromText = (raw: string) => {
  const lines = raw.split("\n").map(collapse).filter(Boolean);
  const line = lines.slice(0, HEADING_SEARCH_LINES).find(isHeading) ?? lines[0];
  return line ? line.slice(0, TITLE_CHARS) : null;
};

const SHEET_LABEL = /RYSUNEK:/;
const SHEET_TITLE_LINES = 4;
const SHEET_FIELD_LABELS = /^(OBIEKT|INWESTOR|ADRES|SKALA|DATA|PROJEKTOWAŁ|PROJEKTANT|SPRAWDZAJĄCY|BRANŻA|STADIUM|NR RYS)/i;
const NOT_A_TITLE = /^PROJEKT (TECHNICZNY|BUDOWLANY|WYKONAWCZY)$/i;

// Columns of a `pdftotext -layout` line: runs of text separated by three or more spaces.
const segments = (line: string) =>
  [...line.matchAll(/\S+(?: {1,2}\S+)*/g)].map((match) => ({ col: match.index, text: collapse(match[0]) }));

// The title in the drawing's title block: the capitals next to or under "RYSUNEK:", in the same column or to its right.
export const sheetTitle = (raw: string) => {
  const lines = raw.split("\n");
  const at = lines.findIndex((line) => SHEET_LABEL.test(line));
  if (at < 0) return null;
  const col = lines[at]!.search(SHEET_LABEL);
  const sameLine = lines[at]!.slice(col).replace(SHEET_LABEL, "");
  const candidates = [" ".repeat(col + 8) + sameLine, ...lines.slice(at + 1, at + 1 + SHEET_TITLE_LINES)];
  for (const line of candidates) {
    for (const segment of segments(line)) {
      if (segment.col < col - 2 || SHEET_FIELD_LABELS.test(segment.text) || NOT_A_TITLE.test(segment.text)) continue;
      if (isHeading(segment.text)) return segment.text.slice(0, TITLE_CHARS);
    }
  }
  return null;
};

// Checked in order: "DETAL 3 – DOCIEPLENIE COKOŁU – PRZEKRÓJ" is a detail, not a section.
const KINDS: [RegExp, SheetKind][] = [
  [/^(detal|szczeg[oó][lł])/, "detal"],
  [/^zestawieni/, "zestawienie"],
  [/^opis/, "opis"],
  [/^rzut/, "rzut"],
  [/^przekr[oó]j/, "przekroj"],
  [/^elewacj/, "elewacja"],
];

export const kindOf = (title: string) => KINDS.find(([pattern]) => pattern.test(title.toLocaleLowerCase("pl")))?.[1];

// --- Contents page ---

type TocEntry = { title: string; from: number; to: number; drawingNo?: string };

const TOC_PAGES = 6;
const MIN_TOC_ENTRIES = 3;
const TOC_LINE = /^(.*?)[\s.…]*\bstr(?:ona|\.)?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/i;
const DRAWING_NO = /\s*[-–]?\s*rys(?:unek|\.)?\s*(?:nr\.?\s*)?(\d+[a-z]?)\s*$/i;

// One entry per line ending with "str. N" or "str. N-M"; a long title wrapped onto the line before is joined back.
export const parseToc = (raw: string): TocEntry[] => {
  const entries: TocEntry[] = [];
  let pending = "";
  for (const line of raw.split("\n").map(collapse)) {
    if (!line) continue;
    const match = TOC_LINE.exec(`${pending} ${line}`.trim());
    if (!match) {
      pending = line.endsWith(":") || !isHeading(line) ? "" : line;
      continue;
    }
    pending = "";
    const from = Number(match[2]);
    const to = match[3] ? Number(match[3]) : from;
    const drawing = DRAWING_NO.exec(match[1]!);
    const title = collapse((drawing ? match[1]!.slice(0, drawing.index) : match[1]!).replace(/[\s.…:–-]+$/, ""));
    if (!title || from < 1 || to < from) continue;
    entries.push({ title, from, to, ...(drawing ? { drawingNo: drawing[1] } : {}) });
  }
  return entries;
};

const findToc = (pages: PageText[]) =>
  pages
    .slice(0, TOC_PAGES)
    .map((page) => ({ pageNo: page.pageNo, entries: parseToc(page.text) }))
    .filter((toc) => toc.entries.length >= MIN_TOC_ENTRIES)
    .sort((a, b) => b.entries.length - a.entries.length)[0];

// --- Matching entries to pages ---

const STOPWORDS = new Set(["i", "w", "z", "na", "nad", "pod", "do", "od", "oraz", "dla", "nr", "rys"]);

// Polish titles differ by inflection and typos ("KLEJENIE" / "KLEJENIA"), so words are compared by their first letters.
const STEM = 5;

const words = (title: string) =>
  title
    .toLocaleLowerCase("pl")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !STOPWORDS.has(word));

// Words every sheet of a design project carries say nothing about which sheet it is.
const GENERIC_STEMS = new Set(["proje", "techn", "budow", "budyn", "obiek"]);

const stems = (title: string) => new Set(words(title).map((word) => word.slice(0, STEM)).filter((stem) => !GENERIC_STEMS.has(stem)));
const numbers = (title: string) => new Set(words(title).filter((word) => /^\d+$/.test(word)));

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((item) => b.has(item));

const MIN_SIMILARITY = 0.6;

// Dice similarity of the stems; "DETAL 1" and "DETAL 10" never match each other.
export const titleSimilarity = (a: string, b: string) => {
  const [numbersA, numbersB] = [numbers(a), numbers(b)];
  if (numbersA.size && numbersB.size && !sameSet(numbersA, numbersB)) return 0;
  const [stemsA, stemsB] = [stems(a), stems(b)];
  if (!stemsA.size || !stemsB.size) return 0;
  const shared = [...stemsA].filter((stem) => stemsB.has(stem)).length;
  return (2 * shared) / (stemsA.size + stemsB.size);
};

type PageTitles = { pageNo: number; sheet: string | null; heading: string | null; hasText: boolean };

const pageTitles = (pages: PageText[]): PageTitles[] =>
  pages.map((page) => ({
    pageNo: page.pageNo,
    sheet: sheetTitle(page.text),
    heading: titleFromText(page.text),
    hasText: page.text.trim().length > 0,
  }));

// Each entry gets the page whose title is most like it; a page goes to one entry only, best pairs first.
const matchEntries = (entries: TocEntry[], titles: PageTitles[]) => {
  const pairs = entries.flatMap((entry, index) =>
    titles.flatMap((page) => {
      const score = Math.max(...[page.sheet, page.heading].map((title) => (title ? titleSimilarity(entry.title, title) : 0)));
      return score >= MIN_SIMILARITY ? [{ index, pageNo: page.pageNo, score, distance: Math.abs(page.pageNo - entry.from) }] : [];
    }),
  );
  pairs.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const matched = new Map<number, number>();
  const taken = new Set<number>();
  for (const pair of pairs) {
    if (matched.has(pair.index) || taken.has(pair.pageNo)) continue;
    matched.set(pair.index, pair.pageNo);
    taken.add(pair.pageNo);
  }
  return matched;
};

type Anchor = { from: number; to: number; offset: number };

// Matches that agree with at least one other match on the shift are trusted to carry it to their unmatched neighbours;
// a lone outlier (a statement listed at the end but bound in the middle) only places itself.
const anchorsOf = (entries: TocEntry[], matched: Map<number, number>, pageCount: number) => {
  const offsets = [...matched].map(([index, pageNo]) => pageNo - entries[index]!.from);
  const shared = (offset: number) => offsets.filter((other) => other === offset).length >= 2 || offsets.length === 1;
  const anchors: Anchor[] = [...matched]
    .map(([index, pageNo]) => ({ from: entries[index]!.from, to: entries[index]!.to, offset: pageNo - entries[index]!.from }))
    .filter((anchor) => shared(anchor.offset));
  // Contents whose last page is the last page of the PDF line up at the end.
  const last = Math.max(...entries.map((entry) => entry.to));
  if (last === pageCount) anchors.push({ from: last, to: last, offset: 0 });
  return anchors;
};

const inferredOffset = (entry: TocEntry, anchors: Anchor[]) => {
  const before = anchors.filter((anchor) => anchor.to <= entry.from).sort((a, b) => b.to - a.to)[0];
  const after = anchors.filter((anchor) => anchor.from >= entry.to).sort((a, b) => a.from - b.from)[0];
  if (!before || !after) return (before ?? after)?.offset ?? 0;
  // On a tie the part that follows wins: inserted pages shift what comes after them.
  return entry.from - before.to < after.from - entry.to ? before.offset : after.offset;
};

const tocSections = (entries: TocEntry[], titles: PageTitles[], pageCount: number): OutlineSection[] => {
  const matched = matchEntries(entries, titles);
  const anchors = anchorsOf(entries, matched, pageCount);
  const placed = entries.map((entry, index) => {
    const pageNo = matched.get(index);
    const from = pageNo ?? entry.from + inferredOffset(entry, anchors);
    const section: OutlineSection = {
      title: entry.title,
      from,
      to: from + (entry.to - entry.from),
      verified: pageNo !== undefined,
    };
    const kind = kindOf(entry.title);
    if (kind) section.kind = kind;
    if (entry.drawingNo) section.drawingNo = entry.drawingNo;
    if (from !== entry.from) section.declared = { from: entry.from, to: entry.to };
    return section;
  });
  return clampSections(placed, pageCount);
};

// Sorted by page, inside the PDF, and a part ends where the next one starts.
const clampSections = (sections: OutlineSection[], pageCount: number) => {
  const inside = sections.filter((section) => section.from >= 1 && section.from <= pageCount).sort((a, b) => a.from - b.from);
  return inside.flatMap((section, i) => {
    const next = inside.slice(i + 1).find((other) => other.from > section.from);
    const to = Math.min(section.to, pageCount, next ? next.from - 1 : pageCount);
    // Two entries placed on the same page: the second one keeps its single page instead of vanishing.
    return [{ ...section, to: Math.max(section.from, to) }];
  });
};

const pageTitle = (page: PageTitles) => page.sheet ?? page.heading ?? (page.hasText ? null : "Strona bez tekstu (skan lub rysunek)");

// Pages no section covers, grouped by title, so nothing in the PDF is missing from the outline.
const gapSections = (sections: OutlineSection[], titles: PageTitles[], extra: boolean): OutlineSection[] => {
  const covered = new Set(sections.flatMap((section) => range(section.from, section.to)));
  const gaps: OutlineSection[] = [];
  for (const page of titles) {
    if (covered.has(page.pageNo)) continue;
    const title = pageTitle(page) ?? `Strona ${page.pageNo}`;
    const previous = gaps.at(-1);
    if (previous && previous.to === page.pageNo - 1 && previous.title === title) {
      previous.to = page.pageNo;
      continue;
    }
    const kind = kindOf(title);
    gaps.push({ title, from: page.pageNo, to: page.pageNo, verified: true, ...(kind ? { kind } : {}), ...(extra ? { extra: true as const } : {}) });
  }
  return gaps;
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// --- Headings inside a text part ---

const ROMAN = /^([IVX]{1,6})\.\s+(\S.*)$/;
const NUMBERED = /^(\d{1,2})\.\s+(\p{Lu}.*)$/u;
const HEADING_CHARS = 90;

const romanValue = (roman: string) => {
  const values: Record<string, number> = { I: 1, V: 5, X: 10 };
  return [...roman].reduce((sum, letter, i) => {
    const value = values[letter]!;
    const next = values[roman[i + 1] ?? ""] ?? 0;
    return sum + (value < next ? -value : value);
  }, 0);
};

type Heading = { level: 1 | 2; title: string; pageNo: number };

// Chapters "I.", "II." and their points "1.", "2."; numbers must follow on, so a numbered list of steps
// ("1. prace przygotowawcze") inside a point does not count.
const headingsOf = (pages: PageText[]) => {
  const headings: Heading[] = [];
  let chapter = 0;
  let point = 0;
  for (const page of pages) {
    for (const line of page.text.split("\n").map(collapse)) {
      const roman = ROMAN.exec(line);
      if (roman && romanValue(roman[1]!) === chapter + 1) {
        chapter++;
        point = 0;
        headings.push({ level: 1, title: line.slice(0, HEADING_CHARS), pageNo: page.pageNo });
        continue;
      }
      const numbered = NUMBERED.exec(line);
      if (numbered && chapter > 0 && Number(numbered[1]) === point + 1) {
        point++;
        headings.push({ level: 2, title: line.slice(0, HEADING_CHARS), pageNo: page.pageNo });
      }
    }
  }
  return headings;
};

// A heading runs to the page where the next one of the same or a higher level starts.
const nest = (headings: Heading[], level: 1 | 2, to: number): OutlineSection[] =>
  headings.flatMap((heading, i) => {
    if (heading.level !== level) return [];
    const rest = headings.slice(i + 1);
    const nextIndex = rest.findIndex((other) => other.level <= level);
    const end = nextIndex < 0 ? to : Math.max(heading.pageNo, rest[nextIndex]!.pageNo);
    const section: OutlineSection = { title: heading.title, from: heading.pageNo, to: end, verified: true };
    const children = level === 1 ? nest(nextIndex < 0 ? rest : rest.slice(0, nextIndex), 2, end) : [];
    return [children.length ? { ...section, children } : section];
  });

const MIN_CHAPTERS = 2;

const withChapters = (section: OutlineSection, pages: PageText[]): OutlineSection => {
  if (section.to === section.from) return section;
  const inside = pages.filter((page) => page.pageNo >= section.from && page.pageNo <= section.to);
  const headings = headingsOf(inside);
  if (headings.filter((heading) => heading.level === 1).length < MIN_CHAPTERS) return section;
  return { ...section, children: nest(headings, 1, section.to) };
};

// --- Building ---

export const buildOutline = (pages: PageText[]): DocumentOutline => {
  const sorted = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  const pageCount = sorted.at(-1)?.pageNo ?? 0;
  const titles = pageTitles(sorted);
  const toc = findToc(sorted);
  const listed = toc ? tocSections(toc.entries, titles, pageCount) : [];
  const sections = [...listed, ...gapSections(listed, titles, Boolean(toc))]
    .sort((a, b) => a.from - b.from)
    .map((section) => withChapters(section, sorted));
  return toc
    ? { version: OUTLINE_VERSION, source: "toc", tocPage: toc.pageNo, sections }
    : { version: OUTLINE_VERSION, source: "pages", sections };
};
