export type IndexedPage = {
  documentId: string;
  filename: string;
  pageNo: number;
  title: string | null;
  kind: string | null;
  summary: string | null;
  keywords: string[];
  text: string;
};

export type SearchIndex = { generatedAt: string; pages: IndexedPage[] };

export type SearchHit = { page: IndexedPage; snippet: string };

type Field = "title" | "keywords" | "summary" | "text";

// A word in a title says more about the page than the same word somewhere in its PDF text.
const FIELD_WEIGHTS: Record<Field, number> = { title: 4, keywords: 3, summary: 2, text: 1 };
const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];
const CODE_WEIGHT = 12;
const SNIPPET_LENGTH = 180;

// People type on site without Polish letters ("cokol"), and NFD does not split ł, so it is mapped by hand.
export const foldText = (text: string) =>
  text
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

const words = (folded: string) => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// The same shortened head the server uses (search.ts), since there is no Polish stemmer: "ocieplenia" → "ociepl".
export const stem = (word: string) => word.slice(0, Math.max(4, Math.ceil(word.length * 0.7)));

// Drawing and detail marks ("rys. A-04", "D-3", "A04") must match as a whole, whatever the separator or zero padding.
// A space is not a separator here, or "do 50 cm" would read as a mark.
const CODE_PATTERN = /(?<![\p{L}\p{N}])(\p{L}{1,3})[.-]?0*(\d{1,4})(\p{L}?)(?![\p{L}\p{N}])/gu;

export const drawingCodes = (folded: string) =>
  new Set([...folded.matchAll(CODE_PATTERN)].map(([, letters, digits, suffix]) => `${letters}${digits}${suffix}`));

type QueryTerms = { stems: string[]; codes: string[] };

export const queryTerms = (query: string): QueryTerms => {
  const folded = foldText(query);
  const codes = [...drawingCodes(folded)];
  const isCode = (word: string) => drawingCodes(word).size > 0;
  const stems = [...new Set(words(folded).filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !isCode(word)).map(stem))];
  return { stems, codes };
};

type PreparedPage = {
  page: IndexedPage;
  words: Record<Field, string[]>;
  codes: Set<string>;
};

const fieldText = (page: IndexedPage, field: Field) =>
  field === "keywords" ? page.keywords.join(" ") : (page[field] ?? "");

const prepare = (page: IndexedPage): PreparedPage => {
  const folded = Object.fromEntries(FIELDS.map((field) => [field, foldText(fieldText(page, field))])) as Record<Field, string>;
  return {
    page,
    words: Object.fromEntries(FIELDS.map((field) => [field, words(folded[field])])) as Record<Field, string[]>,
    codes: drawingCodes(FIELDS.map((field) => folded[field]).join(" ")),
  };
};

// How often a stem starts a word in the field, capped so a long specification does not drown out a matching title.
const stemCount = (fieldWords: string[], term: string) => {
  let count = 0;
  for (const word of fieldWords) if (word.startsWith(term) && ++count === 3) break;
  return count;
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stemPattern = (term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}`, "u");
const codePattern = (code: string) => {
  const [, letters = "", digits = "", suffix = ""] = /^(\p{L}+)(\d+)(\p{L}?)$/u.exec(code) ?? [];
  return new RegExp(`(?<![\\p{L}\\p{N}])${letters}[.-]?0*${digits}${suffix}(?![\\p{L}\\p{N}])`, "u");
};

// Plain text cut around the first place the query matched, so the result shows why the page was found.
export const snippetFor = (page: IndexedPage, terms: QueryTerms) => {
  const source = (page.text.trim() || page.summary || page.title || "").replace(/\s+/g, " ");
  const folded = foldText(source);
  const positions = [...terms.stems.map(stemPattern), ...terms.codes.map(codePattern)]
    .map((pattern) => folded.search(pattern))
    .filter((position) => position >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - SNIPPET_LENGTH / 3);
  const end = Math.min(source.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${source.slice(start, end).trim()}${end < source.length ? "…" : ""}`;
};

// Ranks pages for a query entirely on the phone, so it works on site without signal.
export const createSearcher = (index: SearchIndex) => {
  const prepared = index.pages.map(prepare);
  const total = prepared.length;

  return (query: string, limit = 30): SearchHit[] => {
    const terms = queryTerms(query);
    const termCount = terms.stems.length + terms.codes.length;
    if (termCount === 0) return [];

    // Rare words decide more than words on every page ("rzut" vs "kanalizacja").
    const rarity = new Map(
      terms.stems.map((term) => {
        const pagesWithTerm = prepared.filter((entry) => FIELDS.some((field) => stemCount(entry.words[field], term) > 0)).length;
        return [term, Math.log(1 + total / Math.max(1, pagesWithTerm))];
      }),
    );

    const scored = prepared.flatMap((entry) => {
      let score = 0;
      let matched = 0;
      for (const term of terms.stems) {
        const weight = FIELDS.reduce((sum, field) => sum + FIELD_WEIGHTS[field] * stemCount(entry.words[field], term), 0);
        if (weight > 0) {
          matched += 1;
          score += weight * rarity.get(term)!;
        }
      }
      for (const code of terms.codes) {
        if (entry.codes.has(code)) {
          matched += 1;
          score += CODE_WEIGHT;
        }
      }
      if (matched === 0) return [];
      // A page that has every word of the question beats one that repeats a single word many times.
      return [{ entry, score: score * (matched / termCount) ** 2, hasCode: terms.codes.some((code) => entry.codes.has(code)) }];
    });

    // A mark names one drawing: with "rys. A-04" every other "rysunek" is noise, unless no page carries the mark.
    const withCode = scored.filter((result) => result.hasCode);
    return (withCode.length > 0 ? withCode : scored)
      .sort((a, b) => b.score - a.score || a.entry.page.pageNo - b.entry.page.pageNo)
      .slice(0, limit)
      .map(({ entry }) => ({ page: entry.page, snippet: snippetFor(entry.page, terms) }));
  };
};
