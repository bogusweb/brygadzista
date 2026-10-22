import { abbreviationOf, expandAbbreviations, extractCodes } from "./codes.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { embed } from "./llm.js";
import { drawingRefOf, levelOf, type PageBranch, type PageKind } from "./page-meta.js";

export type PageHit = { documentId: string; filename: string; pageNo: number; title: string | null; snippet: string };

// Question words carry no content, but on a long page they always match and pull in pages that say nothing on the topic.
const STOPWORDS = new Set(
  ("jaki jaka jakie jakiej jakim jakiego jakich jaką jest są ile ilu iloma gdzie czy jak kto co czym czego który która które " +
    "którego się dla przy oraz lub albo nie tak ten tej tego mają ma mieć można należy trzeba według przez pod nad bez jeśli " +
    "być dać musi muszą wynosi").split(" "),
);

const SNIPPET_CHARS = 600;

// Optional filters of search_project (#55). "rysunek" also covers details, which are drawings too.
export type PageFilter = { kind?: PageKind; branch?: PageBranch; level?: string };

const kindsFor = (kind: PageKind) => (kind === "rysunek" ? ["rysunek", "detal"] : [kind]);

// Conditions on the pages table for a filter; empty when there is none.
const pageConditions = (filter: PageFilter) => sql`
  ${filter.kind ? sql`and kind = any(${kindsFor(filter.kind)}::text[])` : sql``}
  ${filter.branch ? sql`and branch = ${filter.branch}` : sql``}
  ${filter.level ? sql`and level = ${levelOf(filter.level) ?? filter.level.toLowerCase()}` : sql``}`;

const hasFilter = (filter: PageFilter) => Boolean(filter.kind || filter.branch || filter.level);

// Polish is heavily inflected and Postgres has no Polish stemmer, so each word becomes a prefix query on its stem-ish head.
const prefix = (word: string) => `${word.slice(0, Math.max(4, Math.ceil(word.length * 0.7)))}:*`;

const queryWords = (query: string) =>
  [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (word) => abbreviationOf(word) !== undefined || (word.length >= 3 && !STOPWORDS.has(word)),
  );

// One tsquery per content word of the question; an abbreviation also matches its spelled-out name (MW = wełna mineralna).
export const queryTerms = (query: string) =>
  queryWords(query).map((word) => {
    const expansion = abbreviationOf(word);
    if (!expansion) return prefix(word);
    const words = [word, ...expansion.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 3)];
    return `(${[...new Set(words)].map(prefix).join(" | ")})`;
  });

export const prefixQuery = (query: string) => queryTerms(query).join(" | ");

// A page counts as an answer by words when it holds at least this share of the question's content words.
const MIN_COVERAGE = 0.5;

// Exported for the retrieval eval (scripts/eval-search.ts), which scores each ranking on its own.
// Pages holding more of the question's words come first; within that, the usual rank and trigram similarity.
export const lexicalSearch = async (projectId: string, query: string, limit: number, filter: PageFilter = {}) => {
  const terms = queryTerms(query);
  const tsquery = terms.join(" | ");
  return sql<{ page_id: string; coverage: number }[]>`
    select id as page_id, coverage from pages,
      lateral (select to_tsvector('simple', search_text) as tsv) doc,
      lateral (select case when ${terms.length}::int = 0 then 0 else
        (select count(*) from unnest(${terms}::text[]) term where doc.tsv @@ to_tsquery('simple', term))::float / ${terms.length}::int
      end as coverage) matched
    where project_id = ${projectId} and search_text <> '' ${pageConditions(filter)}
    order by
      round(coverage::numeric, 2) desc,
      (case when ${tsquery} = '' then 0 else ts_rank(doc.tsv, to_tsquery('simple', ${tsquery})) end)
      + word_similarity(${query}, search_text) desc, page_no
    limit ${limit}`;
};

export const semanticSearch = async (projectId: string, query: string, limit: number, filter: PageFilter = {}) => {
  if (!config.openrouterApiKey) return [];
  const [vector] = await embed([expandAbbreviations(query)]);
  return sql<{ page_id: string; distance: number }[]>`
    select page_id, distance from (
      select page_id, min(embedding <=> ${`[${vector!.join(",")}]`}::vector) as distance
      from chunks where project_id = ${projectId}
      ${hasFilter(filter) ? sql`and page_id in (select id from pages where project_id = ${projectId} ${pageConditions(filter)})` : sql``}
      group by page_id
    ) ranked order by distance limit ${limit}`;
};

// Pages sharing the most exact codes with the query (A-04, Ø120, RAL 9006…); empty when the query has none.
export const codeSearch = async (projectId: string, query: string, limit: number, filter: PageFilter = {}) => {
  const codes = extractCodes(query);
  if (codes.length === 0) return [];
  return sql<{ page_id: string }[]>`
    select id as page_id from pages
    where project_id = ${projectId} and codes && ${codes}::text[] ${pageConditions(filter)}
    order by cardinality(array(select unnest(codes) intersect select unnest(${codes}::text[]))) desc,
      kind is not distinct from 'formalne', page_no
    limit ${limit}`;
};

// The sheet whose title block carries the drawing number the question names ("rys. nr 5"). The table of contents
// lists every number too, so without this it often beats the drawing itself.
export const drawingSearch = async (projectId: string, query: string, filter: PageFilter = {}) => {
  const drawingNo = drawingRefOf(query);
  if (!drawingNo) return [];
  return sql<{ page_id: string }[]>`
    select id as page_id from pages
    where project_id = ${projectId} and drawing_no = ${drawingNo} ${pageConditions(filter)}
    order by page_no`;
};

// The part of the page around the question's words and codes, so the agent sees why the page came up
// without reading it whole. The window is whole lines of the PDF text, up to SNIPPET_CHARS.
export const bestSnippet = (text: string, query: string) => {
  const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const stems = queryWords(query)
    .flatMap((word) => [word, ...(abbreviationOf(word)?.toLowerCase().split(" ") ?? [])])
    .map((word) => word.slice(0, Math.max(4, Math.ceil(word.length * 0.7))));
  const codes = new Set(extractCodes(query));
  const lineScores = lines.map((line) => {
    const words = line.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    const wordHits = stems.filter((stem) => words.some((word) => word.startsWith(stem))).length;
    return wordHits + 2 * extractCodes(line).filter((code) => codes.has(code)).length;
  });
  let best = { start: 0, end: 0, score: -1 };
  for (let start = 0; start < lines.length; start++) {
    let end = start;
    let length = 0;
    let score = 0;
    while (end < lines.length && (end === start || length + lines[end]!.length <= SNIPPET_CHARS)) {
      length += lines[end]!.length + 1;
      score += lineScores[end]!;
      end++;
    }
    if (score > best.score) best = { start, end, score };
  }
  return lines.slice(best.start, best.end).join("\n").slice(0, SNIPPET_CHARS);
};

// Reciprocal rank fusion of the meaning-based, word-based and exact-code rankings. Only pages that pass at least one
// relevance test are returned (an exact code, enough of the question's words, or a close vector), so a question the
// project does not answer gets no results instead of the six least bad pages. A drawing named by its number comes first.
export const searchPages = async (projectId: string, query: string, limit = 6, filter: PageFilter = {}): Promise<PageHit[]> => {
  const [semantic, lexical, codes, drawings] = await Promise.all([
    semanticSearch(projectId, query, limit * 2, filter),
    lexicalSearch(projectId, query, limit * 2, filter),
    codeSearch(projectId, query, limit * 2, filter),
    drawingSearch(projectId, query, filter),
  ]);
  const relevant = new Set([
    ...codes.map((row) => row.page_id),
    ...lexical.filter((row) => row.coverage >= MIN_COVERAGE).map((row) => row.page_id),
    ...semantic.filter((row) => row.distance <= config.searchMaxDistance).map((row) => row.page_id),
  ]);
  const scores = new Map<string, number>();
  for (const ranking of [semantic, lexical, codes]) {
    ranking.forEach((row, rank) => scores.set(row.page_id, (scores.get(row.page_id) ?? 0) + 1 / (60 + rank)));
  }
  const named = drawings.map((row) => row.page_id);
  const fused = [...scores.entries()]
    .filter(([id]) => relevant.has(id) && !named.includes(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const ids = [...named, ...fused].slice(0, limit);
  if (ids.length === 0) return [];
  const rows = await sql<{ id: string; document_id: string; filename: string; page_no: number; title: string | null; raw_text: string }[]>`
    select p.id, p.document_id, d.filename, p.page_no, p.title, p.raw_text
    from pages p join documents d on d.id = p.document_id where p.id in ${sql(ids)}`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [{
      documentId: row.document_id,
      filename: row.filename,
      pageNo: row.page_no,
      title: row.title,
      snippet: bestSnippet(row.raw_text, query),
    }];
  });
};
