import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { pageImagePath } from "./agent.js";
import { canAccessProject, isUuid, requireProjectAccess, requireRole, type AuthEnv } from "./auth.js";
import { actor, fillItem, mapLimit, sourcePages } from "./checklists.js";
import { config } from "./config.js";
import { detached, sql, withTenant } from "./db.js";
import { readLayers } from "./llm.js";
import { limiters, rateLimit } from "./rate-limit.js";
import { bestSnippet, searchPages } from "./search.js";

// Cards of a room ("Łazienka 1.04") or a partition ("Ściana zewnętrzna SZ1") (#71): everything the crew needs about one
// place on one screen, each value with the page it comes from, kept on the phone for work without signal.
// Values are filled the same way as checklist items: a value counts as found only with a quote that is on the cited page.

export const CARD_KINDS = ["room", "partition"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

type FieldTemplate = { key: string; label: string; ask: string; query: string };

const ROOM_FIELDS: FieldTemplate[] = [
  { key: "dimensions", label: "Wymiary", ask: "wymiary pomieszczenia (długość i szerokość)", query: "wymiary długość szerokość" },
  { key: "height", label: "Wysokość", ask: "wysokość pomieszczenia w świetle", query: "wysokość w świetle" },
  { key: "area", label: "Powierzchnia", ask: "powierzchnia użytkowa pomieszczenia w m2", query: "powierzchnia m2" },
  { key: "floorLevel", label: "Rzędna posadzki", ask: "rzędna posadzki pomieszczenia", query: "rzędna posadzki ±0,00 poziom" },
  { key: "floor", label: "Posadzka", ask: "rodzaj posadzki i wykończenia ścian pomieszczenia", query: "posadzka wykończenie płytki" },
  { key: "windows", label: "Okna", ask: "okna w pomieszczeniu: symbole, wymiary, wysokość parapetu", query: "okno symbol wymiary parapet" },
  { key: "doors", label: "Drzwi", ask: "drzwi do pomieszczenia: symbole i wymiary", query: "drzwi symbol wymiary" },
  {
    key: "installations",
    label: "Punkty instalacyjne",
    ask: "punkty instalacyjne w pomieszczeniu: gniazda, oświetlenie, woda, kanalizacja, wentylacja, ogrzewanie",
    query: "instalacja gniazdo oświetlenie woda kanalizacja wentylacja grzejnik",
  },
];

const PARTITION_FIELDS: FieldTemplate[] = [
  { key: "thickness", label: "Grubość całkowita", ask: "całkowita grubość przegrody", query: "grubość przegrody" },
  { key: "u", label: "Współczynnik U", ask: "współczynnik przenikania ciepła U przegrody w W/m2K", query: "współczynnik przenikania ciepła U W/m2K" },
  { key: "structure", label: "Konstrukcja", ask: "materiał i grubość warstwy konstrukcyjnej przegrody", query: "materiał konstrukcja grubość" },
];

const LAYER_QUERY = "warstwy przegrody grubość materiał ocieplenie tynk";
const LAYER_PAGES = 3;
const FIELD_CONCURRENCY = 3;

export const cardFields = (kind: CardKind) => (kind === "room" ? ROOM_FIELDS : PARTITION_FIELDS);

type Source = { documentId: string; pageNo: number; quote: string | null };
type Status = "found" | "to_confirm";
export type CardField = { key: string; label: string; value: string | null; status: Status; source: Source | null };
export type CardLayer = { material: string; thickness: string | null; status: Status; source: Source | null };

const normalize = (text: string) => text.toLowerCase().replace(/[„”"«»]/g, "").replace(/\s+/g, " ").trim();

// The question is about one place, so its name leads every search and every question to the model.
const fillField = async (projectId: string, name: string, field: FieldTemplate): Promise<CardField> => {
  const filled = await fillItem(projectId, { label: field.label, ask: `${field.ask} – „${name}”`, query: `${name} ${field.query}` });
  return {
    key: field.key,
    label: field.label,
    value: filled.value,
    status: filled.status,
    source: filled.documentId && filled.pageNo ? { documentId: filled.documentId, pageNo: filled.pageNo, quote: filled.quote } : null,
  };
};

// Layers whose quote is not on the cited page stay on the card as "do potwierdzenia", never as fact.
const findLayers = async (projectId: string, name: string): Promise<CardLayer[]> => {
  if (!config.openrouterApiKey) return [];
  const hits = await searchPages(projectId, `${name} ${LAYER_QUERY}`, LAYER_PAGES);
  if (!hits.length) return [];
  const pages = await sourcePages(projectId, hits);
  const found = await readLayers(name, pages);
  return found.map((layer) => {
    const page = pages.find((candidate) => candidate.documentId === layer.documentId && candidate.pageNo === layer.pageNo);
    const quoted = page && layer.quote.trim() && normalize(page.text).includes(normalize(layer.quote));
    const cited = page ?? pages[0]!;
    return {
      material: layer.material.trim(),
      thickness: layer.thickness.trim() || null,
      status: quoted ? "found" : "to_confirm",
      source: { documentId: cited.documentId, pageNo: cited.pageNo, quote: quoted ? layer.quote.trim() : bestSnippet(cited.text, layer.material) },
    };
  });
};

const build = async (cardId: string) => {
  const [card] = await sql<{ projectId: string; kind: CardKind; name: string }[]>`
    select project_id as "projectId", kind, name from element_cards where id = ${cardId}`;
  if (!card) return;
  try {
    const [fields, layers] = await Promise.all([
      mapLimit(cardFields(card.kind), FIELD_CONCURRENCY, (field) => fillField(card.projectId, card.name, field)),
      card.kind === "partition" ? findLayers(card.projectId, card.name) : Promise.resolve([]),
    ]);
    await sql`
      update element_cards set fields = ${sql.json(fields)}, layers = ${sql.json(layers)}, status = 'ready', error = null,
        generated_at = now()
      where id = ${cardId}`;
  } catch (error) {
    console.error(`card ${cardId}: building failed`, error);
    await sql`update element_cards set status = 'error', error = 'Nie udało się zebrać danych z projektu, spróbuj ponownie' where id = ${cardId}`;
  }
};

const inFlight = new Map<string, Promise<void>>();

// One build per card at a time: the agent and the app asking for the same card wait for the same work.
export const buildCard = (cardId: string): Promise<void> => {
  const running = inFlight.get(cardId);
  if (running) return running;
  const run = build(cardId).finally(() => inFlight.delete(cardId));
  inFlight.set(cardId, run);
  return run;
};

// Waits for the card's build when one is running (the agent answers from the finished card; tests wait this way too).
export const cardSettled = (cardId: string) => inFlight.get(cardId) ?? Promise.resolve();

export const failInterruptedCards = () =>
  sql`update element_cards set status = 'error', error = 'Zbieranie danych przerwane, spróbuj ponownie' where status = 'generating'`;

type CardRow = {
  id: string;
  projectId: string;
  kind: CardKind;
  name: string;
  status: string;
  error: string | null;
  fields: CardField[];
  layers: CardLayer[];
  createdBy: string;
  createdAt: Date;
  generatedAt: Date | null;
};

const withImage = (source: Source | null) => (source ? { ...source, imagePath: pageImagePath(source.documentId, source.pageNo) } : null);

export const cardView = async (cardId: string) => {
  const [card] = await sql<CardRow[]>`
    select id, project_id as "projectId", kind, name, status, error, fields, layers, created_by_name as "createdBy",
      created_at as "createdAt", generated_at as "generatedAt"
    from element_cards where id = ${cardId}`;
  if (!card) return null;
  // Missing values are listed by name, so "brak danych" is said outright and not left to an empty screen.
  const missing = card.status === "ready" ? card.fields.filter((field) => field.status === "to_confirm" && !field.value).map((field) => field.label) : [];
  return {
    ...card,
    fields: card.fields.map((field) => ({ ...field, source: withImage(field.source) })),
    layers: card.layers.map((layer) => ({ ...layer, source: withImage(layer.source) })),
    missing,
  };
};

const cardName = (name: string) => name.replace(/\s+/g, " ").trim();

// The same place asked for twice is the same card; `refresh` collects its data from the project again.
export const requestCard = async (
  projectId: string,
  { kind, name, refresh = false }: { kind: CardKind; name: string; refresh?: boolean },
  who: { id: string | null; name: string },
) => {
  const [card] = await sql<{ id: string; status: string }[]>`
    insert into element_cards (project_id, kind, name, created_by, created_by_name)
    values (${projectId}, ${kind}, ${cardName(name)}, ${who.id}, ${who.name})
    on conflict (project_id, kind, lower(name)) do update set
      status = case when ${refresh} or element_cards.status = 'error' then 'generating' else element_cards.status end,
      error = case when ${refresh} or element_cards.status = 'error' then null else element_cards.error end
    returning id, status`;
  if (card!.status === "generating") detached(() => buildCard(card!.id));
  return card!.id;
};

const projectOfCard = async (cardId: string) => {
  if (!isUuid(cardId)) return null;
  const [card] = await sql<{ projectId: string }[]>`select project_id as "projectId" from element_cards where id = ${cardId}`;
  return card?.projectId ?? null;
};

const requireCardAccess = (): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const projectId = await projectOfCard(c.req.param("id") ?? "");
  const tenantId = projectId ? await canAccessProject(c.get("principal"), projectId) : null;
  if (!tenantId) return c.json({ error: "Nie ma takiej karty" }, 404);
  await withTenant(tenantId, next);
};

export const cardRequest = z.object({
  kind: z.enum(CARD_KINDS),
  name: z.string().trim().min(1).max(120),
  refresh: z.boolean().optional(),
});

export const cards = new Hono<AuthEnv>();

cards.get("/api/projects/:id/cards", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const rows = await sql<{ id: string }[]>`select id from element_cards where project_id = ${c.req.param("id")} order by kind, lower(name)`;
  return c.json(await Promise.all(rows.map((row) => cardView(row.id))));
});

// Filling a card costs a model call per value, so it counts against the same per-user limit as chat.
cards.post("/api/projects/:id/cards", requireRole("app", "admin"), requireProjectAccess(), rateLimit(limiters.chat), async (c) => {
  const parsed = cardRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Podaj rodzaj karty i nazwę pomieszczenia albo przegrody" }, 400);
  const projectId = c.req.param("id");
  const [page] = await sql`select 1 from pages where project_id = ${projectId} and search_text <> '' limit 1`;
  if (!page) return c.json({ error: "Projekt nie ma jeszcze zindeksowanych stron" }, 409);
  const id = await requestCard(projectId, parsed.data, actor(c.get("principal")));
  return c.json(await cardView(id), 202);
});

cards.get("/api/cards/:id", requireRole("app", "admin"), requireCardAccess(), async (c) => c.json(await cardView(c.req.param("id"))));

cards.delete("/api/cards/:id", requireRole("app", "admin"), requireCardAccess(), async (c) => {
  await sql`delete from element_cards where id = ${c.req.param("id")}`;
  return c.body(null, 204);
});
