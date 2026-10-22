import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { pageImagePath } from "./agent.js";
import { canAccessProject, isUuid, requireProjectAccess, requireRole, type AuthEnv, type Principal } from "./auth.js";
import { buildingType, DEFAULT_BUILDING_TYPE, projectTemplates } from "./building-types.js";
import { stageTemplate, STAGE_TEMPLATES, type ChecklistItemTemplate } from "./checklist-templates.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { readChecklistValue, type ChecklistSourcePage } from "./llm.js";
import { limiters, rateLimit } from "./rate-limit.js";
import { bestSnippet, searchPages } from "./search.js";

// Items are filled a few at a time, each from the best pages the project search finds for it.
const ITEM_CONCURRENCY = 3;
const SOURCE_PAGES = 3;
const PAGE_TEXT_CHARS = 6000;
// The app's clock may be off; a change dated further ahead than this counts as made now.
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

type ItemStatus = "found" | "to_confirm";

type FilledItem = {
  value: string | null;
  status: ItemStatus;
  documentId: string | null;
  pageNo: number | null;
  quote: string | null;
};

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const sourcePages = async (projectId: string, hits: { documentId: string; pageNo: number }[]) => {
  const rows = await sql<ChecklistSourcePage[]>`
    select document_id as "documentId", page_no as "pageNo", title, left(raw_text, ${PAGE_TEXT_CHARS}) as text
    from pages where project_id = ${projectId}
      and document_id = any(${hits.map((hit) => hit.documentId)}::uuid[]) and page_no = any(${hits.map((hit) => hit.pageNo)}::int[])`;
  return hits.flatMap((hit) => rows.filter((row) => row.documentId === hit.documentId && row.pageNo === hit.pageNo));
};

// A value counts as found only with a quote that really is on the cited page; anything else stays "do potwierdzenia",
// pointing at the page where the search saw the topic, so the crew knows where to look.
export const fillItem = async (projectId: string, item: ChecklistItemTemplate): Promise<FilledItem> => {
  const hits = await searchPages(projectId, item.query, SOURCE_PAGES);
  const top = hits[0];
  if (!top) return { value: null, status: "to_confirm", documentId: null, pageNo: null, quote: null };
  const lead: FilledItem = { value: null, status: "to_confirm", documentId: top.documentId, pageNo: top.pageNo, quote: top.snippet };
  if (!config.openrouterApiKey) return lead;

  const pages = await sourcePages(projectId, hits);
  const finding = await readChecklistValue(item.ask, pages);
  if (!finding) return lead;
  const page = pages.find((candidate) => candidate.documentId === finding.documentId && candidate.pageNo === finding.pageNo);
  if (page && finding.quote && normalize(page.text).includes(normalize(finding.quote))) {
    return { value: finding.value, status: "found", documentId: page.documentId, pageNo: page.pageNo, quote: finding.quote };
  }
  const cited = page ?? pages[0];
  return cited
    ? { value: finding.value, status: "to_confirm", documentId: cited.documentId, pageNo: cited.pageNo, quote: bestSnippet(cited.text, item.query) }
    : { ...lead, value: finding.value };
};

const mapLimit = async <T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await task(items[i]!);
  });
  await Promise.all(workers);
  return results;
};

// Runs in the background after the checklist is created; the app polls the checklist until it is ready.
export const generateChecklist = async (checklistId: string) => {
  const [checklist] = await sql<{ projectId: string; stage: string }[]>`
    select project_id as "projectId", stage from checklists where id = ${checklistId}`;
  const template = checklist && stageTemplate(checklist.stage);
  if (!checklist || !template) return;
  try {
    const filled = await mapLimit(template.items, ITEM_CONCURRENCY, (item) => fillItem(checklist.projectId, item));
    await sql.begin(async (tx) => {
      await tx`delete from checklist_items where checklist_id = ${checklistId}`;
      for (const [position, item] of template.items.entries()) {
        const fill = filled[position]!;
        await tx`
          insert into checklist_items (checklist_id, position, label, ask, value, status, document_id, page_no, quote)
          values (${checklistId}, ${position}, ${item.label}, ${item.ask}, ${fill.value}, ${fill.status},
            ${fill.documentId}, ${fill.pageNo}, ${fill.quote})`;
      }
      await tx`update checklists set status = 'ready', error = null, generated_at = now() where id = ${checklistId}`;
    });
  } catch (error) {
    console.error(`checklist ${checklistId}: generation failed`, error);
    await sql`update checklists set status = 'error', error = ${"Nie udało się wypełnić checklisty z projektu, spróbuj ponownie"}
      where id = ${checklistId}`;
  }
};

// A restart drops the background generation, so a checklist still marked as generating will never finish.
export const failInterruptedChecklists = () =>
  sql`update checklists set status = 'error', error = 'Generowanie przerwane, spróbuj ponownie' where status = 'generating'`;

const actor = ({ user, role }: Principal) =>
  user ? { id: user.id, name: user.name || user.email } : { id: null, name: role === "admin" ? "Administrator" : "Aplikacja (wspólny dostęp)" };

type ItemRow = {
  id: string;
  position: number;
  label: string;
  ask: string;
  value: string | null;
  status: ItemStatus;
  documentId: string | null;
  pageNo: number | null;
  quote: string | null;
  checked: boolean;
  note: string | null;
  checkedAt: Date | null;
  checkedBy: string | null;
};

const itemRows = (checklistId: string) => sql<ItemRow[]>`
  select id, position, label, ask, value, status, document_id as "documentId", page_no as "pageNo", quote,
    checked, note, checked_at as "checkedAt", checked_by_name as "checkedBy"
  from checklist_items where checklist_id = ${checklistId} order by position`;

const itemView = ({ documentId, pageNo, quote, ...item }: ItemRow) => ({
  ...item,
  source: documentId && pageNo ? { documentId, pageNo, quote, imagePath: pageImagePath(documentId, pageNo) } : null,
});

export const checklistView = async (checklistId: string) => {
  const [checklist] = await sql<{ id: string; projectId: string; stage: string; title: string; status: string; error: string | null }[]>`
    select id, project_id as "projectId", stage, title, status, error, created_by_name as "createdBy",
      created_at as "createdAt", generated_at as "generatedAt"
    from checklists where id = ${checklistId}`;
  if (!checklist) return null;
  const results = await sql`
    select id, completed_at as "completedAt", completed_by_name as "completedBy", items
    from checklist_results where checklist_id = ${checklistId} order by completed_at desc`;
  return {
    ...checklist,
    when: stageTemplate(checklist.stage)?.when ?? null,
    items: (await itemRows(checklistId)).map(itemView),
    results,
  };
};

const at = z.iso.datetime({ offset: true });

const syncEvent = z.discriminatedUnion("type", [
  z.object({
    id: z.uuid(),
    type: z.literal("check"),
    itemId: z.uuid(),
    checked: z.boolean(),
    note: z.string().max(2000).nullish(),
    at,
  }),
  z.object({ id: z.uuid(), type: z.literal("complete"), at }),
]);

const syncBody = z.object({ events: z.array(syncEvent).max(500) });

type SyncEvent = z.infer<typeof syncEvent>;

const happenedAt = (event: SyncEvent) => new Date(Math.min(Date.parse(event.at), Date.now() + MAX_CLOCK_SKEW_MS));

// Changes made offline arrive later, possibly from several phones. Each event is applied once (by its id) and the
// latest change of an item wins by the time it was made, not the time it reached the server.
const applyEvents = async (checklistId: string, events: SyncEvent[], principal: Principal) => {
  const who = actor(principal);
  const ordered = [...events].sort((a, b) => happenedAt(a).getTime() - happenedAt(b).getTime());
  await sql.begin(async (tx) => {
    for (const event of ordered) {
      const when = happenedAt(event);
      const [fresh] = await tx`
        insert into checklist_events (id, checklist_id, item_id, type, checked, note, happened_at, user_id, user_name)
        values (${event.id}, ${checklistId}, ${event.type === "check" ? event.itemId : null}, ${event.type},
          ${event.type === "check" ? event.checked : null}, ${event.type === "check" ? (event.note ?? null) : null},
          ${when}, ${who.id}, ${who.name})
        on conflict (id) do nothing returning id`;
      if (!fresh) continue;
      if (event.type === "check") {
        await tx`
          update checklist_items set checked = ${event.checked}, note = ${event.note ?? null}, checked_at = ${when},
            checked_by = ${who.id}, checked_by_name = ${who.name}
          where id = ${event.itemId} and checklist_id = ${checklistId} and (checked_at is null or checked_at <= ${when})`;
      } else {
        const items = await tx`
          select label, value, status, page_no as "pageNo", checked, note, checked_by_name as "checkedBy", checked_at as "checkedAt"
          from checklist_items where checklist_id = ${checklistId} order by position`;
        await tx`
          insert into checklist_results (id, checklist_id, completed_at, completed_by, completed_by_name, items)
          values (${event.id}, ${checklistId}, ${when}, ${who.id}, ${who.name}, ${tx.json(items)})`;
      }
    }
  });
};

const projectOfChecklist = async (checklistId: string) => {
  if (!isUuid(checklistId)) return null;
  const [checklist] = await sql<{ projectId: string }[]>`select project_id as "projectId" from checklists where id = ${checklistId}`;
  return checklist?.projectId ?? null;
};

const requireChecklistAccess = (): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const projectId = await projectOfChecklist(c.req.param("id") ?? "");
  if (!projectId || !(await canAccessProject(c.get("principal"), projectId))) return c.json({ error: "Nie ma takiej checklisty" }, 404);
  await next();
};

export const checklists = new Hono<AuthEnv>();

checklists.get("/api/checklist-templates", requireRole("app", "admin"), (c) =>
  c.json(STAGE_TEMPLATES.map(({ stage, title, when, items }) => ({ stage, title, when, items: items.map((item) => item.label) }))),
);

checklists.get("/api/projects/:id/checklist-templates", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const [project] = await sql<{ buildingType: string }[]>`select building_type as "buildingType" from projects where id = ${c.req.param("id")}`;
  const type = buildingType(project!.buildingType) ?? buildingType(DEFAULT_BUILDING_TYPE)!;
  return c.json({ buildingType: type.type, label: type.label, templates: projectTemplates(type.type) });
});

checklists.get("/api/projects/:id/checklists", requireRole("app", "admin"), requireProjectAccess(), async (c) =>
  c.json(await sql`
    select c.id, c.stage, c.title, c.status, c.created_by_name as "createdBy", c.created_at as "createdAt",
      count(i.id)::int as "itemCount",
      count(i.id) filter (where i.checked)::int as "checkedCount",
      count(i.id) filter (where i.status = 'to_confirm')::int as "toConfirmCount",
      (select max(r.completed_at) from checklist_results r where r.checklist_id = c.id) as "lastCompletedAt"
    from checklists c left join checklist_items i on i.checklist_id = c.id
    where c.project_id = ${c.req.param("id")}
    group by c.id order by c.created_at desc`),
);

// Filling a checklist costs a model call per item, so it counts against the same per-user limit as chat.
checklists.post("/api/projects/:id/checklists", requireRole("app", "admin"), requireProjectAccess(), rateLimit(limiters.chat), async (c) => {
  const body = await c.req.json<{ stage?: unknown }>().catch(() => ({}) as { stage?: unknown });
  const template = typeof body.stage === "string" ? stageTemplate(body.stage) : undefined;
  if (!template) return c.json({ error: "Nieznany etap budowy" }, 400);
  const projectId = c.req.param("id");
  const [page] = await sql`select 1 from pages where project_id = ${projectId} and search_text <> '' limit 1`;
  if (!page) return c.json({ error: "Projekt nie ma jeszcze zindeksowanych stron" }, 409);
  const who = actor(c.get("principal"));
  const [checklist] = await sql<{ id: string }[]>`
    insert into checklists (project_id, stage, title, created_by, created_by_name)
    values (${projectId}, ${template.stage}, ${template.title}, ${who.id}, ${who.name}) returning id`;
  void generateChecklist(checklist!.id);
  return c.json(await checklistView(checklist!.id), 202);
});

checklists.get("/api/checklists/:id", requireRole("app", "admin"), requireChecklistAccess(), async (c) =>
  c.json(await checklistView(c.req.param("id"))),
);

checklists.post("/api/checklists/:id/sync", requireRole("app", "admin"), requireChecklistAccess(), async (c) => {
  const parsed = syncBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Nieprawidłowe zmiany checklisty" }, 400);
  const checklistId = c.req.param("id");
  const [checklist] = await sql<{ status: string }[]>`select status from checklists where id = ${checklistId}`;
  if (checklist?.status !== "ready") return c.json({ error: "Checklista nie jest jeszcze gotowa" }, 409);
  const itemIds = new Set((await itemRows(checklistId)).map((item) => item.id));
  if (parsed.data.events.some((event) => event.type === "check" && !itemIds.has(event.itemId))) {
    return c.json({ error: "Nie ma takiej pozycji na tej checkliście" }, 400);
  }
  await applyEvents(checklistId, parsed.data.events, c.get("principal"));
  return c.json(await checklistView(checklistId));
});

checklists.delete("/api/checklists/:id", requireRole("admin"), requireChecklistAccess(), async (c) => {
  await sql`delete from checklists where id = ${c.req.param("id")}`;
  return c.body(null, 204);
});
