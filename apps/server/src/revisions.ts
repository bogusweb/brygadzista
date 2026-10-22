import { Hono } from "hono";
import { pageImagePath } from "./agent.js";
import { requireDocumentAccess, requireProjectAccess, requireRole, type AuthEnv } from "./auth.js";
import { sql } from "./db.js";
import { formatFact } from "./facts.js";

// Versions of a project (#72): a new PDF uploaded as a revision of a document keeps the old one for reference, and the
// crew gets the list of what changed between them. Pages are paired by drawing number, then by title, then by page
// number; on each pair the parameters from the index (#53) and the lines of text are compared.

const LINES_SHOWN = 4;
// Changes of a large pair of documents are computed once and reused for a while: search asks for them on every question.
const CACHE_MS = 60_000;

type PageRow = { id: string; pageNo: number; title: string | null; drawingNo: string | null; text: string };
type FactRow = { pageId: string; label: string; value: string; unit: string };

export type FactChange = { label: string; before: string | null; after: string | null };

export type PageChange = {
  kind: "changed" | "added" | "removed";
  pageNo: number | null;
  previousPageNo: number | null;
  title: string | null;
  drawingNo: string | null;
  facts: FactChange[];
  linesAdded: string[];
  linesRemoved: string[];
};

// A document is superseded once a newer revision of it has finished indexing; until then the old one still answers.
export const supersededDocuments = () => sql`
  select d.revision_of from documents d where d.revision_of is not null and d.status = 'ready'`;

const titleKey = (title: string | null) =>
  title
    ?.toLowerCase()
    .replace(/\(rys\.[^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() || null;

const drawingKey = (drawingNo: string | null) => drawingNo?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") || null;

// Each new page takes the first unpaired old page with the same drawing number, else the same title, else the same number.
export const pairPages = <T extends Pick<PageRow, "pageNo" | "title" | "drawingNo">>(before: T[], after: T[]) => {
  const unpaired = new Set(before);
  const take = (match: (page: T) => boolean) => {
    const found = [...unpaired].find(match);
    if (found) unpaired.delete(found);
    return found ?? null;
  };
  const pairs: { before: T | null; after: T | null }[] = [];
  const pending: T[] = [];
  for (const page of after) {
    const drawing = drawingKey(page.drawingNo);
    const paired = drawing ? take((old) => drawingKey(old.drawingNo) === drawing) : null;
    if (paired) pairs.push({ before: paired, after: page });
    else pending.push(page);
  }
  const rest: T[] = [];
  for (const page of pending) {
    const title = titleKey(page.title);
    const paired = title ? take((old) => !drawingKey(old.drawingNo) && titleKey(old.title) === title) : null;
    if (paired) pairs.push({ before: paired, after: page });
    else rest.push(page);
  }
  for (const page of rest) pairs.push({ before: take((old) => old.pageNo === page.pageNo && !drawingKey(old.drawingNo)), after: page });
  for (const old of unpaired) pairs.push({ before: old, after: null });
  return pairs;
};

const factKey = (fact: { label: string; unit: string }) => `${fact.label.toLowerCase()}|${fact.unit}`;

const factValues = (facts: FactRow[]) => {
  const byKey = new Map<string, { label: string; values: Set<string> }>();
  for (const fact of facts) {
    const entry = byKey.get(factKey(fact)) ?? { label: fact.label, values: new Set<string>() };
    entry.values.add(formatFact(fact));
    byKey.set(factKey(fact), entry);
  }
  return byKey;
};

const joined = (values: Set<string> | undefined) => (values?.size ? [...values].sort().join(", ") : null);

// Parameters whose values differ, appeared or disappeared on the page.
export const compareFacts = (before: FactRow[], after: FactRow[]): FactChange[] => {
  const old = factValues(before);
  const fresh = factValues(after);
  const changes: FactChange[] = [];
  for (const key of new Set([...old.keys(), ...fresh.keys()])) {
    const was = joined(old.get(key)?.values);
    const is = joined(fresh.get(key)?.values);
    if (was !== is) changes.push({ label: (fresh.get(key) ?? old.get(key))!.label, before: was, after: is });
  }
  return changes;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => /[\p{L}\d]/u.test(line));

export const compareLines = (before: string, after: string) => {
  const old = new Set(lines(before));
  const fresh = new Set(lines(after));
  return {
    linesAdded: [...fresh].filter((line) => !old.has(line)),
    linesRemoved: [...old].filter((line) => !fresh.has(line)),
  };
};

const documentPages = (documentId: string) => sql<PageRow[]>`
  select id, page_no as "pageNo", title, drawing_no as "drawingNo", raw_text as text
  from pages where document_id = ${documentId} order by page_no`;

const documentFacts = (documentId: string) => sql<FactRow[]>`
  select f.page_id as "pageId", f.label, f.value, f.unit from facts f join pages p on p.id = f.page_id
  where p.document_id = ${documentId}`;

const computeChanges = async (documentId: string, previousId: string): Promise<PageChange[]> => {
  const [before, after, oldFacts, newFacts] = await Promise.all([
    documentPages(previousId),
    documentPages(documentId),
    documentFacts(previousId),
    documentFacts(documentId),
  ]);
  const factsOf = (facts: FactRow[], page: PageRow | null) => (page ? facts.filter((fact) => fact.pageId === page.id) : []);
  const changes = pairPages(before, after).flatMap(({ before: old, after: page }) => {
    const facts = compareFacts(factsOf(oldFacts, old), factsOf(newFacts, page));
    const { linesAdded, linesRemoved } = compareLines(old?.text ?? "", page?.text ?? "");
    if (old && page && !facts.length && !linesAdded.length && !linesRemoved.length) return [];
    return [{
      kind: !old ? "added" : !page ? "removed" : "changed",
      pageNo: page?.pageNo ?? null,
      previousPageNo: old?.pageNo ?? null,
      title: page?.title ?? old?.title ?? null,
      drawingNo: page?.drawingNo ?? old?.drawingNo ?? null,
      facts,
      linesAdded: old ? linesAdded.slice(0, LINES_SHOWN) : [],
      linesRemoved: page ? linesRemoved.slice(0, LINES_SHOWN) : [],
    } satisfies PageChange];
  });
  // In the order of the new version; removed pages where they stood in the old one.
  return changes.sort((a, b) => (a.pageNo ?? a.previousPageNo ?? 0) - (b.pageNo ?? b.previousPageNo ?? 0));
};

const cache = new Map<string, { at: number; previousId: string; changes: PageChange[] }>();

type RevisionRow = { documentId: string; filename: string; previousId: string; previousFilename: string; createdAt: Date };

const revisionOf = async (documentId: string) => {
  const [row] = await sql<RevisionRow[]>`
    select d.id as "documentId", d.filename, d.revision_of as "previousId", p.filename as "previousFilename", d.created_at as "createdAt"
    from documents d join documents p on p.id = d.revision_of
    where d.id = ${documentId} and d.status = 'ready'`;
  return row ?? null;
};

export const revisionChanges = async (documentId: string) => {
  const revision = await revisionOf(documentId);
  if (!revision) return null;
  const cached = cache.get(documentId);
  if (cached && cached.previousId === revision.previousId && Date.now() - cached.at < CACHE_MS) return { revision, changes: cached.changes };
  const changes = await computeChanges(documentId, revision.previousId);
  cache.set(documentId, { at: Date.now(), previousId: revision.previousId, changes });
  return { revision, changes };
};

// What the agent should know about the pages it found: the value before and after on a page of a newer version.
export const changesOnPages = async (pages: { documentId: string; pageNo: number }[]) => {
  const byPage = new Map<string, FactChange[]>();
  for (const documentId of new Set(pages.map((page) => page.documentId))) {
    const found = await revisionChanges(documentId);
    for (const change of found?.changes ?? []) {
      if (change.pageNo !== null && change.facts.length) byPage.set(`${documentId}:${change.pageNo}`, change.facts);
    }
  }
  return byPage;
};

const withImages = (revision: RevisionRow, changes: PageChange[]) =>
  changes.map((change) => ({
    ...change,
    imagePath: change.pageNo === null ? null : pageImagePath(revision.documentId, change.pageNo),
    previousImagePath: change.previousPageNo === null ? null : pageImagePath(revision.previousId, change.previousPageNo),
  }));

// Newest revisions first, each with how many pages changed, for the app's notice and the list of changes.
export const projectRevisions = async (projectId: string) => {
  const rows = await sql<{ id: string }[]>`
    select id from documents where project_id = ${projectId} and revision_of is not null and status = 'ready' order by created_at desc`;
  const revisions = await Promise.all(rows.map((row) => revisionChanges(row.id)));
  return revisions.flatMap((found) =>
    found
      ? [{ ...found.revision, changes: withImages(found.revision, found.changes), changedPages: found.changes.length }]
      : [],
  );
};

export const revisions = new Hono<AuthEnv>();

revisions.get("/api/projects/:id/revisions", requireRole("app", "admin"), requireProjectAccess(), async (c) =>
  c.json(await projectRevisions(c.req.param("id"))),
);

revisions.get("/api/documents/:id/changes", requireRole("app", "admin"), requireDocumentAccess(), async (c) => {
  const found = await revisionChanges(c.req.param("id"));
  if (!found) return c.json({ error: "To nie jest gotowa nowa wersja dokumentu" }, 404);
  return c.json({ ...found.revision, changes: withImages(found.revision, found.changes) });
});
