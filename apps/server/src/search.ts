import { expandAbbreviations, extractCodes } from "./codes.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { embed } from "./llm.js";

export type PageHit = { documentId: string; filename: string; pageNo: number; title: string | null; snippet: string };

// Polish is heavily inflected and Postgres has no Polish stemmer, so each word becomes a prefix query on its stem-ish head.
export const prefixQuery = (query: string) =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
    .map((word) => `${word.slice(0, Math.max(4, Math.ceil(word.length * 0.7)))}:*`)
    .join(" | ");

// Exported for the retrieval eval (scripts/eval-search.ts), which scores each ranking on its own.
export const lexicalSearch = async (projectId: string, query: string, limit: number) => {
  const tsquery = prefixQuery(expandAbbreviations(query));
  return sql<{ page_id: string }[]>`
    select id as page_id from pages
    where project_id = ${projectId} and search_text <> ''
    order by
      (case when ${tsquery} = '' then 0 else ts_rank(to_tsvector('simple', search_text), to_tsquery('simple', ${tsquery})) end)
      + word_similarity(${query}, search_text) desc, page_no
    limit ${limit}`;
};

export const semanticSearch = async (projectId: string, query: string, limit: number) => {
  if (!config.openrouterApiKey) return [];
  const [vector] = await embed([expandAbbreviations(query)]);
  return sql<{ page_id: string }[]>`
    select page_id from (
      select page_id, min(embedding <=> ${`[${vector!.join(",")}]`}::vector) as distance
      from chunks where project_id = ${projectId}
      group by page_id
    ) ranked order by distance limit ${limit}`;
};

// Pages sharing the most exact codes with the query (A-04, Ø120, RAL 9006…); empty when the query has none.
export const codeSearch = async (projectId: string, query: string, limit: number) => {
  const codes = extractCodes(query);
  if (codes.length === 0) return [];
  return sql<{ page_id: string }[]>`
    select id as page_id from pages
    where project_id = ${projectId} and codes && ${codes}::text[]
    order by cardinality(array(select unnest(codes) intersect select unnest(${codes}::text[]))) desc, page_no
    limit ${limit}`;
};

// Reciprocal rank fusion of the meaning-based, word-based and exact-code rankings.
export const searchPages = async (projectId: string, query: string, limit = 6): Promise<PageHit[]> => {
  const rankings = await Promise.all([
    semanticSearch(projectId, query, limit * 2),
    lexicalSearch(projectId, query, limit * 2),
    codeSearch(projectId, query, limit * 2),
  ]);
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((row, rank) => scores.set(row.page_id, (scores.get(row.page_id) ?? 0) + 1 / (60 + rank)));
  }
  const ids = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  if (ids.length === 0) return [];
  const rows = await sql<{ id: string; document_id: string; filename: string; page_no: number; title: string | null; summary: string | null; raw_text: string }[]>`
    select p.id, p.document_id, d.filename, p.page_no, p.title, p.summary, p.raw_text
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
      snippet: (row.summary ?? row.raw_text).slice(0, 600),
    }];
  });
};
