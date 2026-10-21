// Exact codes and symbols from construction drawings and descriptions (#50): sheet and detail marks (A-04, C-C, D1),
// classes and profiles (C25/30, RK40x40x2, PIR120), diameters (Ø120), values with units (0,035, 15 cm), standards
// (PN-81/B-03020) and short capitalised marks (RAL 9006, ZL IV, BSO). Full-text search splits these on punctuation
// and drops short parts, so they are matched on their own, written one canonical way on both sides.

const UNITS = new Set(["mm", "cm", "m", "m2", "m3", "kg", "kn", "mpa", "szt", "w"]);
const UNIT_SUFFIX = /^(.*\d)(mm|cm|m2|m3|m|kg|kn|mpa|szt)$/;
const MAX_MARK_LETTERS = 5;
// Words that name a sheet or detail: with the mark after them they form one code ("rys. nr 5" → "rys5", "DETAL 3" → "detal3").
const SHEET_WORDS = new Set(["rys", "rysunek", "detal", "szczegol", "przekroj"]);
const NUMBER_WORDS = new Set(["nr", "no"]);

// One spelling for diameter signs, decimal commas and dashes; Polish letters are folded so "ø" and "Ø" match.
const normalize = (text: string) =>
  text
    .replace(/\u00ad/g, "")
    .replace(/[∅⌀Φφ]/g, "Ø")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[łŁ]/g, (letter) => (letter === "ł" ? "l" : "L"))
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

// Bump when extraction changes: pages with an older version get their codes again from stored text at startup.
export const CODES_VERSION = 2;

// Separators inside a code are dropped (A-04, A.04 and A04 are one mark); a dot between digits is a decimal point.
// Leading zeros after letters are dropped too, so "A04" finds "SZCZEGÓŁ A4".
const canonical = (token: string) =>
  token
    .toLowerCase()
    .replace(/(?<!\d)\.|\.(?!\d)|-/g, "")
    .replace(/(?<=\p{L})0+(?=\d)/gu, "");

const isNumber = (token: string) => /^\d+(\.\d+)?$/.test(token);
const hasDigit = (token: string) => /\d/.test(token);
const isLetters = (token: string) => /^[\p{L}]+$/u.test(token);
const isUpper = (token: string) => token === token.toUpperCase() && token !== token.toLowerCase();

type Token = { raw: string; code: string };

const tokenize = (text: string): Token[] =>
  normalize(text)
    .split(/[\s;:()[\]{}"'„”«»!?,=*+±]+/u)
    .map((raw) => raw.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter(Boolean)
    .map((raw) => ({ raw, code: canonical(raw) }));

// A letters-only token counts as a mark when it is written in capitals (RAL, BSO, ZL, C-C) or uses a symbol (λD).
const isMark = (token: Token) =>
  isLetters(token.code) && token.code.length <= MAX_MARK_LETTERS && (isUpper(token.raw) || /[λø]/.test(token.code));

const keepAlone = (token: Token) => {
  if (isMark(token)) return token.code.length >= 2;
  if (!hasDigit(token.code)) return false;
  if (isNumber(token.code)) return token.code.includes(".") || token.code.length >= 3;
  return true;
};

export const extractCodes = (text: string): string[] => {
  const tokens = tokenize(text);
  const codes = new Set<string>();
  tokens.forEach((token, i) => {
    if (keepAlone(token)) codes.add(token.code);
    const unit = token.code.match(UNIT_SUFFIX);
    if (unit && keepAlone({ raw: unit[1]!, code: unit[1]! })) codes.add(unit[1]!);
    const next = tokens[i + 1];
    if (!next) return;
    // "RAL 9006", "ZL IV" and "ZL I" are also written without the space; "15 cm" is the same as "15cm".
    if (isMark(token) && (isNumber(next.code) || isMark(next) || (isLetters(next.code) && isUpper(next.raw) && next.code.length === 1))) {
      codes.add(token.code + next.code);
    }
    if (isNumber(token.code) && UNITS.has(next.code)) codes.add(token.code + next.code);
    if (SHEET_WORDS.has(token.code)) {
      const mark = NUMBER_WORDS.has(next.code) ? tokens[i + 2] : next;
      if (mark && mark.code.length <= MAX_MARK_LETTERS && (hasDigit(mark.code) || isUpper(mark.raw))) codes.add(token.code + mark.code);
    }
  });
  return [...codes];
};

// Trade abbreviations and their spelled-out names, so a question in one form finds a page written in the other.
const ABBREVIATIONS: Record<string, string> = {
  mw: "wełna mineralna",
  "wełna": "MW",
  xps: "styrodur polistyren ekstrudowany",
  styrodur: "XPS",
  eps: "styropian",
  styropian: "EPS",
  bso: "bezspoinowy system ociepleń",
  pcv: "PVC",
  pvc: "PCV",
  "żb": "żelbet żelbetowy",
  "żelbet": "żb",
  gazobeton: "beton komórkowy",
  "ppoż": "przeciwpożarowy",
  wlz: "wewnętrzna linia zasilająca",
  gk: "płyta gipsowo-kartonowa",
};

export const abbreviationOf = (word: string): string | undefined => ABBREVIATIONS[word.toLowerCase()];

export const expandAbbreviations = (query: string) => {
  const extra = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((word) => ABBREVIATIONS[word] ?? []);
  return extra.length ? `${query} ${[...new Set(extra)].join(" ")}` : query;
};
