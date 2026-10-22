// Splits a page's PDF text (pdftotext -layout) into fragments for embedding along its structure (#56): numbered
// sections of a description (3.2.1…), paragraphs, and tables cut between rows with their header repeated, so a schedule
// row never loses its column names. The length limit is only a safety net for a block that has no structure.

export const CHUNK_CHARS = 2000;

// Columns in a layout line are separated by runs of three or more spaces; a row of a table has at least this many.
const TABLE_MIN_CELLS = 3;
const TABLE_MIN_ROWS = 2;
const SECTION_HEADING = /^(?:\d+(?:\.\d+)*\.?|[IVX]+\.|[a-z]\)|§\s*\d+\.?)\s+\p{L}/u;

type Block = { kind: "section" | "text" | "table"; lines: string[] };

const cellsOf = (line: string) => line.trim().split(/\s{3,}/).filter(Boolean);

const isTableRow = (line: string) => cellsOf(line).length >= TABLE_MIN_CELLS;

const prose = (line: string) => line.replace(/\s+/g, " ").trim();

const tableRow = (line: string) => cellsOf(line).join(" | ");

// Blocks in reading order: a run of table rows is one table; text is cut at blank lines and before section headings.
const blocksOf = (raw: string): Block[] => {
  const blocks: Block[] = [];
  let text: Block | null = null;
  let table: string[] = [];
  const flushTable = () => {
    if (table.length >= TABLE_MIN_ROWS) blocks.push({ kind: "table", lines: table.map(tableRow) });
    else if (table.length) {
      text ??= { kind: "text", lines: [] };
      text.lines.push(...table.map(prose));
      if (!blocks.includes(text)) blocks.push(text);
    }
    table = [];
  };
  for (const line of raw.split("\n")) {
    // Layout output often leaves blank lines between table rows, so only text ends a table.
    if (!line.trim()) {
      text = null;
      continue;
    }
    if (isTableRow(line)) {
      text = null;
      table.push(line);
      continue;
    }
    flushTable();
    if (SECTION_HEADING.test(line.trim()) || !text) {
      text = { kind: SECTION_HEADING.test(line.trim()) ? "section" : "text", lines: [] };
      blocks.push(text);
    }
    text.lines.push(prose(line));
  }
  flushTable();
  return blocks.filter((block) => block.lines.length);
};

// The safety net: a line longer than the limit is cut at spaces.
const splitLong = (line: string, limit: number) => {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf(" ", limit);
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
};

// Lines packed into pieces up to the limit; a table's pieces each start with its header row.
const pieces = (block: Block, limit: number) => {
  const header = block.kind === "table" ? block.lines[0]! : null;
  const body = header ? block.lines.slice(1) : block.lines;
  const room = header ? limit - header.length - 1 : limit;
  const out: string[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (current.length) out.push((header ? [header, ...current] : current).join("\n"));
    current = [];
    length = 0;
  };
  for (const line of body.flatMap((line) => splitLong(line, room))) {
    if (length + line.length + 1 > room) flush();
    current.push(line);
    length += line.length + 1;
  }
  flush();
  return out.length ? out : header ? [header] : [];
};

// Whole blocks are packed together up to the limit; a block that does not fit alone is cut into pieces.
export const chunkPage = (raw: string, limit = CHUNK_CHARS): string[] => {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocksOf(raw)) {
    const text = block.lines.join("\n");
    if (current && current.length + text.length + 2 <= limit) {
      current += `\n\n${text}`;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    if (text.length <= limit) {
      current = text;
      continue;
    }
    chunks.push(...pieces(block, limit));
  }
  if (current) chunks.push(current);
  return chunks;
};
