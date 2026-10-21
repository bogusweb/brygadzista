import { config } from "./config.js";
import { sql } from "./db.js";
import { findDefectSpec, type SpecPage } from "./defect-llm.js";
import type { DefectSpec } from "./pins.js";
import { codeSearch, lexicalSearch } from "./search.js";

// What the project says about a defect (#74): "wg rys. A-05 parapet na 90 cm", with a quote, found by the server after
// the phone syncs the description. It is not part of the pin the phone edits, so it never fights the phone's last-write-wins.

const OTHER_PAGES = 4;
const PAGE_TEXT_CHARS = 4000;

type PageRow = { id: string; documentId: string; pageNo: number; title: string | null; summary: string | null; facts: unknown; rawText: string };

const pageText = (page: PageRow) =>
  [page.summary ?? "", Array.isArray(page.facts) && page.facts.length ? JSON.stringify(page.facts) : "", page.rawText]
    .filter(Boolean)
    .join("\n")
    .slice(0, PAGE_TEXT_CHARS);

// The defect's own drawing, then pages that share words or codes with the note (both free, no embedding call).
const specPages = async (pin: { projectId: string; documentId: string; pageNo: number; note: string; room: string }) => {
  const words = `${pin.room} ${pin.note}`;
  const [lexical, codes] = await Promise.all([lexicalSearch(pin.projectId, words, OTHER_PAGES * 2), codeSearch(pin.projectId, words, OTHER_PAGES)]);
  const found = [...codes.map((row) => row.page_id), ...lexical.filter((row) => row.coverage > 0).map((row) => row.page_id)];
  const rows = await sql<PageRow[]>`
    select id, document_id as "documentId", page_no as "pageNo", title, summary, facts, raw_text as "rawText" from pages
    where (document_id = ${pin.documentId} and page_no = ${pin.pageNo})${found.length ? sql` or id in ${sql(found)}` : sql``}`;
  const own = rows.find((row) => row.documentId === pin.documentId && row.pageNo === pin.pageNo);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const others = [...new Set(found)].flatMap((id) => (id === own?.id ? [] : (byId.get(id) ?? [])));
  return [...(own ? [own] : []), ...others.slice(0, OTHER_PAGES)];
};

// The model must quote the page word for word; a quote that is not on the page is treated as nothing found.
const normalize = (text: string) => text.toLowerCase().replace(/[„”"«»]/g, "").replace(/\s+/g, " ").trim();

const notFound: DefectSpec = { found: false, statement: "", quote: "", source: null };

// FAKE_AGENT=1 and tests without a mock: the first line of the defect's own page, so the app shows the block without a key.
const fakeSpec = (pages: SpecPage[]): DefectSpec => {
  const page = pages[0];
  const line = page?.text.split("\n").map((text) => text.trim()).find(Boolean);
  if (!page || !line) return notFound;
  return { found: true, statement: `Wg str. ${page.pageNo}: ${line}`, quote: line, source: { documentId: page.documentId, pageNo: page.pageNo, title: page.title } };
};

const lookUp = async (pinId: string) => {
  const [pin] = await sql<{ projectId: string; documentId: string; pageNo: number; note: string; room: string }[]>`
    select project_id as "projectId", document_id as "documentId", page_no as "pageNo", note, room from pins
    where id = ${pinId} and kind = 'defect' and spec_note is distinct from note`;
  if (!pin) return;
  if (!pin.note) {
    await sql`update pins set spec = null, spec_note = note where id = ${pinId}`;
    return;
  }
  if (!config.fakeAgent && !config.openrouterApiKey) return;
  const rows = await specPages(pin);
  const pages: SpecPage[] = rows.map((row) => ({ documentId: row.documentId, pageNo: row.pageNo, title: row.title, text: pageText(row) }));
  let spec = notFound;
  if (config.fakeAgent) spec = fakeSpec(pages);
  else if (pages.length) {
    const answer = await findDefectSpec(pin, pages);
    const page = pages[answer.page - 1];
    const quoted = page && answer.quote.trim() && normalize(page.text).includes(normalize(answer.quote));
    if (answer.found && page && quoted) {
      spec = { found: true, statement: answer.statement.trim(), quote: answer.quote.trim(), source: { documentId: page.documentId, pageNo: page.pageNo, title: page.title } };
    }
  }
  // Only for the note it was asked about: an edit synced meanwhile starts its own lookup.
  await sql`update pins set spec = ${sql.json(spec)}, spec_note = ${pin.note} where id = ${pinId} and note = ${pin.note}`;
};

const inFlight = new Map<string, Promise<void>>();

export const describeDefect = (pinId: string): Promise<void> => {
  const running = inFlight.get(pinId);
  // A second edit while the first lookup runs is picked up when it ends.
  if (running) return running.then(() => describeDefect(pinId));
  const run = lookUp(pinId)
    .catch((error) => console.error(`defects: looking up pin ${pinId} in the project failed`, error))
    .finally(() => inFlight.delete(pinId));
  inFlight.set(pinId, run);
  return run;
};

// Tests wait for the background work this way.
export const defectSpecsIdle = () => Promise.all(inFlight.values()).then(() => undefined);

// Descriptions synced while the server was down or without a key are looked up after a restart, one by one.
export const resumeDefectSpecs = async () => {
  const rows = await sql<{ id: string }[]>`
    select id from pins where kind = 'defect' and spec_note is distinct from note order by updated_at`;
  for (const { id } of rows) await describeDefect(id);
};
