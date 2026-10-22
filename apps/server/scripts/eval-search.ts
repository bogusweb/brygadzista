// Retrieval eval: how often search finds the page a question is about (#48).
//   pnpm --filter @brygadzista/server eval -- --pdf <file.pdf>       index the PDF into a scratch project, then score it
//   pnpm --filter @brygadzista/server eval -- --project <project id> score a project that is already indexed
// Options: --questions <file.json> (default eval/hala-pilawa.json), --verbose (every question with its ranking).
// Without OPENROUTER_API_KEY only the text ranking runs, so the eval also works offline and costs nothing.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { defaultTenantId, migrate, sql } from "../src/db.js";
import { processNextDocument } from "../src/ingest.js";
import { codeSearch, lexicalSearch, searchPages, semanticSearch } from "../src/search.js";
import { documentDir, documentPdf } from "../src/storage.js";

type Question = { id: string; kind: string; question: string; pages: number[] };
type QuestionSet = { document: string; questions: Question[] };
type Ranking = "tekst" | "wektor" | "kody" | "hybryda";

const TOP_K = 6;
const DEPTH = 12;

// pnpm passes the "--" separator through to the script.
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    pdf: { type: "string" },
    project: { type: "string" },
    questions: { type: "string", default: new URL("../eval/hala-pilawa.json", import.meta.url).pathname },
    verbose: { type: "boolean", default: false },
  },
});

const pageNumbers = async (projectId: string, pageIds: string[]) => {
  if (pageIds.length === 0) return [];
  const rows = await sql<{ id: string; page_no: number }[]>`
    select id, page_no from pages where project_id = ${projectId} and id in ${sql(pageIds)}`;
  const byId = new Map(rows.map((row) => [row.id, row.page_no]));
  return pageIds.flatMap((id) => byId.get(id) ?? []);
};

const rank = async (projectId: string, ranking: Ranking, query: string): Promise<number[]> => {
  if (ranking === "hybryda") return (await searchPages(projectId, query, TOP_K)).map((hit) => hit.pageNo);
  const search = { tekst: lexicalSearch, wektor: semanticSearch, kody: codeSearch }[ranking];
  const rows = await search(projectId, query, DEPTH);
  return pageNumbers(projectId, rows.map((row) => row.page_id));
};

// The scratch project is reused while it holds the same file, so a rerun does not pay for indexing again.
const indexPdf = async (file: string) => {
  const name = `eval: ${path.basename(file)}`;
  const [existing] = await sql<{ id: string; status: string }[]>`
    select p.id, d.status from projects p join documents d on d.project_id = p.id where p.name = ${name} limit 1`;
  if (existing?.status === "ready") return existing.id;
  if (existing) await sql`delete from projects where id = ${existing.id}`;

  const [project] = await sql<{ id: string }[]>`insert into projects (name, tenant_id) values (${name}, ${await defaultTenantId()}) returning id`;
  const [doc] = await sql<{ id: string }[]>`
    insert into documents (project_id, filename, status) values (${project!.id}, ${path.basename(file)}, 'queued') returning id`;
  await mkdir(documentDir(doc!.id), { recursive: true });
  await copyFile(file, documentPdf(doc!.id));
  console.log(`Indeksuję ${file}${config.openrouterApiKey ? "" : " (bez klucza: tylko tekst)"}…`);
  while (await processNextDocument()) {}
  const [result] = await sql<{ status: string; error: string | null }[]>`select status, error from documents where id = ${doc!.id}`;
  if (result?.status !== "ready") throw new Error(`Indeksowanie nie powiodło się: ${result?.error}`);
  if (result.error) console.warn(result.error);
  return project!.id;
};

type Score = { found1: boolean; found3: boolean; found6: boolean; reciprocalRank: number; empty: boolean };

const score = (expected: number[], ranked: number[]): Score => {
  const position = ranked.findIndex((pageNo) => expected.includes(pageNo));
  return {
    found1: position === 0,
    found3: position >= 0 && position < 3,
    found6: position >= 0 && position < TOP_K,
    reciprocalRank: position >= 0 ? 1 / (position + 1) : 0,
    empty: ranked.length === 0,
  };
};

const percent = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);

// Questions with expected pages are scored by recall and MRR; "brak" questions (nothing in the project)
// by how often search correctly returns nothing.
const summarize = (rows: { question: Question; score: Score }[]) => {
  const answerable = rows.filter((row) => row.question.pages.length > 0);
  const unanswerable = rows.filter((row) => row.question.pages.length === 0);
  return {
    pytania: rows.length,
    "recall@1": percent(answerable.filter((row) => row.score.found1).length, answerable.length),
    "recall@3": percent(answerable.filter((row) => row.score.found3).length, answerable.length),
    "recall@6": percent(answerable.filter((row) => row.score.found6).length, answerable.length),
    MRR: answerable.length ? (answerable.reduce((sum, row) => sum + row.score.reciprocalRank, 0) / answerable.length).toFixed(2) : "–",
    "pusty wynik dla „brak”": percent(unanswerable.filter((row) => row.score.empty).length, unanswerable.length),
  };
};

const main = async () => {
  if (!args.pdf && !args.project) throw new Error("Podaj --pdf <plik.pdf> albo --project <id projektu>");
  await migrate();
  const projectId = args.project ?? (await indexPdf(path.resolve(args.pdf!)));
  const set = JSON.parse(await readFile(args.questions!, "utf8")) as QuestionSet;
  const rankings: Ranking[] = config.openrouterApiKey ? ["tekst", "wektor", "kody", "hybryda"] : ["tekst", "kody", "hybryda"];

  console.log(`\n${set.document}\nProjekt ${projectId}, ${set.questions.length} pytań, rankingi: ${rankings.join(", ")}\n`);
  const results = new Map<Ranking, { question: Question; score: Score; ranked: number[] }[]>();
  for (const ranking of rankings) {
    const rows = [];
    for (const question of set.questions) {
      const ranked = await rank(projectId, ranking, question.question);
      rows.push({ question, ranked, score: score(question.pages, ranking === "hybryda" ? ranked : ranked.slice(0, TOP_K)) });
    }
    results.set(ranking, rows);
  }

  console.log("Całość:");
  console.table(Object.fromEntries(rankings.map((ranking) => [ranking, summarize(results.get(ranking)!)])));
  const kinds = [...new Set(set.questions.map((question) => question.kind))];
  for (const ranking of rankings) {
    console.log(`Według rodzaju pytania (${ranking}):`);
    console.table(Object.fromEntries(kinds.map((kind) => [kind, summarize(results.get(ranking)!.filter((row) => row.question.kind === kind))])));
  }

  if (args.verbose) {
    for (const ranking of rankings) {
      console.log(`\nSzczegóły (${ranking}):`);
      for (const row of results.get(ranking)!) {
        const mark = row.question.pages.length ? (row.score.found3 ? "✓" : row.score.found6 ? "~" : "✗") : row.score.empty ? "✓" : "✗";
        console.log(`${mark} ${row.question.id}: oczekiwane [${row.question.pages.join(", ")}], wynik [${row.ranked.slice(0, TOP_K).join(", ")}]`);
      }
    }
  }
};

try {
  await main();
} finally {
  await sql.end();
}
