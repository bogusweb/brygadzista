import { sql, dropEmbeddingSet } from "./db.js";
import type { EmbeddingModel } from "./embedding-model.js";

export type EmbeddingSet = EmbeddingModel & { id: string };

type SetRow = { id: string; model: string; dimensions: number; error: string | null; retry_at: Date | null };

const selectSet = (status: "active" | "building") =>
  sql<SetRow[]>`select id, model, dimensions, error, retry_at from embedding_sets where status = ${status} limit 1`.then(
    ([row]) => row,
  );

const toSet = (row: SetRow): EmbeddingSet => ({ id: row.id, model: row.model, dimensions: row.dimensions });

// The set search reads (#46): the one complete set, old model or new.
export const activeEmbeddingSet = async () => {
  const row = await selectSet("active");
  return row ? toSet(row) : null;
};

// The set being built for the configured model, while search still reads the old one.
export const buildingEmbeddingSet = async () => {
  const row = await selectSet("building");
  return row ? { ...toSet(row), error: row.error, retryAt: row.retry_at } : null;
};

// Indexing always embeds with the configured model: into the set being built during a change, else the active one.
export const writeEmbeddingSet = async () => (await buildingEmbeddingSet()) ?? (await activeEmbeddingSet());

// Indexed pages that have no vectors in the set yet.
export const pagesMissingFrom = (setId: string, limit: number) =>
  sql<{ id: string; document_id: string; project_id: string; page_no: number; title: string | null; raw_text: string }[]>`
    select p.id, p.document_id, p.project_id, p.page_no, p.title, p.raw_text from pages p
    where p.indexed and not exists (select 1 from chunks c where c.page_id = p.id and c.embedding_set = ${setId})
    order by p.id limit ${limit}`;

// Progress of a set: indexed pages that already have vectors in it, out of all indexed pages.
export const setProgress = async (setId: string) => {
  const [row] = await sql<{ done: number; total: number }[]>`
    select (select count(distinct page_id)::int from chunks where embedding_set = ${setId}) as done,
      (select count(*)::int from pages where indexed) as total`;
  return row!;
};

// Makes the finished set the active one in one transaction, so a search reads either the old vectors or the new ones,
// never a mix; the old vectors are deleted afterwards. False when a page still lacks vectors in the new set.
export const switchToSet = async (setId: string) => {
  const old = await sql.begin(async (tx) => {
    await tx`lock table embedding_sets in exclusive mode`;
    const [missing] = await tx`
      select 1 from pages p where p.indexed and not exists (select 1 from chunks c where c.page_id = p.id and c.embedding_set = ${setId})
      limit 1`;
    if (missing) return null;
    const [previous] = await tx<{ id: string }[]>`update embedding_sets set status = 'retired' where status = 'active' returning id`;
    await tx`update embedding_sets set status = 'active', activated_at = now(), error = null, retry_at = null where id = ${setId}`;
    return previous?.id ?? "";
  });
  if (old === null) return false;
  if (old) await dropEmbeddingSet(old);
  return true;
};

export const recordSetError = (setId: string, error: string | null, retryAt: Date | null) =>
  sql`update embedding_sets set error = ${error}, retry_at = ${retryAt} where id = ${setId}`;

// What the dashboard shows: the model search uses, and the progress of a model change.
export const embeddingStatus = async () => {
  const [active, building] = await Promise.all([activeEmbeddingSet(), buildingEmbeddingSet()]);
  return {
    active: active ? { model: active.model, dimensions: active.dimensions } : null,
    building: building
      ? { model: building.model, dimensions: building.dimensions, error: building.error, ...(await setProgress(building.id)) }
      : null,
  };
};
