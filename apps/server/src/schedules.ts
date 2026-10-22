import { Hono } from "hono";
import { pageImagePath } from "./agent.js";
import { requireProjectAccess, requireRole, type AuthEnv } from "./auth.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { readScheduleRows, type ScheduleRowFinding } from "./llm.js";
import { limiters, rateLimit } from "./rate-limit.js";
import { SCHEDULE_CATEGORIES, type ScheduleCategory } from "./schedule-categories.js";

// Material schedules from the project (#67): rows of the steel, lintel, window, door and precast tables, read once per
// page by the model and kept with the page they come from. A row counts towards totals only when its numbers are on that
// page; the rest is listed as "do sprawdzenia", so an order to the wholesaler never carries a number the model made up.

// Bump when reading changes: schedule pages with an older version are read again on the next request.
export const SCHEDULE_VERSION = 1;

export const CATEGORY_LABELS: Record<ScheduleCategory, string> = {
  stal: "Stal zbrojeniowa",
  nadproza: "Nadproża",
  okna: "Stolarka okienna",
  drzwi: "Stolarka drzwiowa",
  prefabrykaty: "Prefabrykaty",
  inne: "Inne",
};

// Schedules sit on pages of their own and in the corner of structural drawings, so the text decides as well as the kind.
const SCHEDULE_TEXT = String.raw`zestawienie\s+(stali|stolarki|nadpro|prefabryk|zbrojenia|prętów|elementów|okien|drzwi|belek)`;

const schedulePages = (projectId: string) => sql<{ id: string; documentId: string; pageNo: number; title: string | null; text: string; version: number | null }[]>`
  select id, document_id as "documentId", page_no as "pageNo", title, raw_text as text, schedule_version as version
  from pages where project_id = ${projectId} and (kind = 'zestawienie' or raw_text ~* ${SCHEDULE_TEXT})
  order by document_id, page_no`;

// Tables lose their spacing in PDF text: "84 x 142", "84×142" and "245,6" are matched as "84x142" and "245.6".
const normalizeNumbers = (text: string) =>
  text
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/(\d)\s*x\s*(?=\d)/g, "$1x")
    .replace(/(\d),(?=\d)/g, "$1.")
    .replace(/\s+/g, " ");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasToken = (page: string, token: string) =>
  new RegExp(`(?<![\\p{L}\\d.])${escape(token)}(?![\\p{L}\\d])`, "u").test(page);

// "159,60" in the table is the same number as 159.6 from the model.
const hasNumber = (page: string, value: number) =>
  [...page.matchAll(/(?<![\p{L}\d.])\d+(?:\.\d+)?(?![\d])/gu)].some((match) => Math.abs(Number(match[0]) - value) < 1e-9);

// Every number that would go into an order (quantity, dimensions) and the row's symbol must be on the page.
export const rowOnPage = (row: Pick<ScheduleRowFinding, "mark" | "dimensions" | "quantity">, pageText: string) => {
  const page = normalizeNumbers(pageText);
  const tokens = [
    ...normalizeNumbers(row.dimensions).split(/[\s;,/]+/).filter((token) => /\d/.test(token)),
    ...normalizeNumbers(row.mark).split(/[\s.]+/).filter((token) => token && token !== "poz"),
  ];
  return (row.quantity === null || hasNumber(page, row.quantity)) && tokens.every((token) => hasToken(page, token.replace(/[.:]+$/, "")));
};

const extractPage = async (page: { id: string; projectId: string; documentId: string; pageNo: number; title: string | null; text: string }) => {
  try {
    const rows = await readScheduleRows({ documentId: page.documentId, pageNo: page.pageNo, title: page.title, text: page.text });
    await sql.begin(async (tx) => {
      await tx`delete from schedule_items where page_id = ${page.id}`;
      const items = rows
        .filter((row) => row.description.trim() || row.mark.trim())
        .map((row, position) => ({
          page_id: page.id,
          project_id: page.projectId,
          document_id: page.documentId,
          page_no: page.pageNo,
          position,
          category: row.category,
          element: row.element.trim(),
          level: row.level.trim(),
          mark: row.mark.trim(),
          description: row.description.trim(),
          dimensions: row.dimensions.trim(),
          quantity: row.quantity,
          unit: row.unit.trim(),
          quote: row.quote.trim(),
          verified: rowOnPage(row, page.text),
        }));
      if (items.length) await tx`insert into schedule_items ${tx(items)}`;
      await tx`update pages set schedule_version = ${SCHEDULE_VERSION}, schedule_error = null where id = ${page.id}`;
    });
  } catch (error) {
    console.error(`schedules: reading page ${page.pageNo} of document ${page.documentId} failed`, error);
    await sql`
      update pages set schedule_version = ${SCHEDULE_VERSION}, schedule_error = 'Nie udało się odczytać zestawienia' where id = ${page.id}`;
  }
};

const inFlight = new Map<string, Promise<void>>();

// One reading per project at a time; the app, the dashboard and the agent asking together wait for the same work.
export const extractSchedules = (projectId: string): Promise<void> => {
  const running = inFlight.get(projectId);
  if (running) return running;
  const run = (async () => {
    for (const page of await schedulePages(projectId)) {
      if (page.version !== SCHEDULE_VERSION) await extractPage({ ...page, projectId });
    }
  })().finally(() => inFlight.delete(projectId));
  inFlight.set(projectId, run);
  return run;
};

export const schedulesSettled = (projectId: string) => inFlight.get(projectId) ?? Promise.resolve();

export type ScheduleFilter = { category?: ScheduleCategory; element?: string; mark?: string };

type ItemRow = {
  id: string;
  documentId: string;
  pageNo: number;
  pageTitle: string | null;
  category: ScheduleCategory;
  element: string;
  level: string;
  mark: string;
  description: string;
  dimensions: string;
  quantity: number | null;
  unit: string;
  quote: string;
  verified: boolean;
};

const DIAMETER = /(?:Ø|ø|φ|fi)\s*(\d{1,2})\b/iu;

// What rows add up under: steel by diameter, everything else by symbol (or description) and size.
const groupLabel = (item: ItemRow) => {
  if (item.category === "stal") {
    const diameter = DIAMETER.exec(`${item.description} ${item.mark}`)?.[1];
    if (diameter) return `Ø${diameter}`;
  }
  return [item.mark || item.description, item.dimensions].filter(Boolean).join(" ");
};

export const scheduleTotals = (items: ItemRow[]) => {
  const totals = new Map<string, { category: ScheduleCategory; label: string; unit: string; quantity: number; rows: number }>();
  for (const item of items) {
    if (!item.verified || item.quantity === null) continue;
    const label = groupLabel(item);
    const key = `${item.category}|${label}|${item.unit}`;
    const total = totals.get(key) ?? { category: item.category, label, unit: item.unit, quantity: 0, rows: 0 };
    total.quantity = Math.round((total.quantity + item.quantity) * 1000) / 1000;
    total.rows += 1;
    totals.set(key, total);
  }
  return [...totals.values()];
};

const matches = (item: ItemRow, { category, element, mark }: ScheduleFilter) => {
  if (category && item.category !== category) return false;
  const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);
  if (element) {
    const haystack = `${item.element} ${item.level} ${item.description} ${item.pageTitle ?? ""}`.toLowerCase();
    if (!words(element).every((word) => haystack.includes(word))) return false;
  }
  if (mark && !`${item.mark} ${item.description}`.toLowerCase().includes(mark.toLowerCase())) return false;
  return true;
};

export const projectSchedule = async (projectId: string, filter: ScheduleFilter = {}) => {
  const pages = await schedulePages(projectId);
  const pending = pages.filter((page) => page.version !== SCHEDULE_VERSION);
  if (pending.length && config.openrouterApiKey) void extractSchedules(projectId);
  const rows = await sql<ItemRow[]>`
    select i.id, i.document_id as "documentId", i.page_no as "pageNo", p.title as "pageTitle", i.category, i.element, i.level,
      i.mark, i.description, i.dimensions, i.quantity, i.unit, i.quote, i.verified
    from schedule_items i join pages p on p.id = i.page_id
    where i.project_id = ${projectId} order by i.document_id, i.page_no, i.position`;
  const items = rows.filter((item) => matches(item, filter));
  const failed = await sql<{ pageNo: number }[]>`
    select page_no as "pageNo" from pages where project_id = ${projectId} and schedule_error is not null order by page_no`;
  return {
    status: pending.length === 0 ? "ready" : config.openrouterApiKey ? "reading" : "no_model",
    pages: pages.map((page) => ({ documentId: page.documentId, pageNo: page.pageNo, title: page.title, imagePath: pageImagePath(page.documentId, page.pageNo) })),
    failedPages: failed.map((page) => page.pageNo),
    items: items.map((item) => ({ ...item, quantity: item.quantity === null ? null : Number(item.quantity) })),
    totals: scheduleTotals(items.map((item) => ({ ...item, quantity: item.quantity === null ? null : Number(item.quantity) }))),
  };
};

const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : typeof value === "number" ? String(value).replace(".", ",") : value;
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Semicolons and decimal commas, with a BOM, so Excel in Polish opens it straight into columns.
export const scheduleCsv = (items: Awaited<ReturnType<typeof projectSchedule>>["items"]) => {
  const header = ["Kategoria", "Element", "Kondygnacja", "Symbol", "Opis", "Wymiary", "Ilość", "Jedn.", "Strona", "Uwagi"];
  const lines = items.map((item) =>
    [
      CATEGORY_LABELS[item.category],
      item.element,
      item.level,
      item.mark,
      item.description,
      item.dimensions,
      item.quantity,
      item.unit,
      item.pageNo,
      item.verified ? "" : "do sprawdzenia w projekcie",
    ]
      .map(csvCell)
      .join(";"),
  );
  return `﻿${[header.join(";"), ...lines].join("\r\n")}\r\n`;
};

const filterFrom = (query: Record<string, string>): ScheduleFilter => ({
  category: SCHEDULE_CATEGORIES.find((category) => category === query.category),
  element: query.element?.trim() || undefined,
  mark: query.mark?.trim() || undefined,
});

export const schedules = new Hono<AuthEnv>();

schedules.get("/api/projects/:id/schedules", requireRole("app", "admin"), requireProjectAccess(), async (c) =>
  c.json(await projectSchedule(c.req.param("id"), filterFrom(c.req.query()))),
);

schedules.get("/api/projects/:id/schedules.csv", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const { items } = await projectSchedule(c.req.param("id"), filterFrom(c.req.query()));
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="zestawienie.csv"');
  return c.body(scheduleCsv(items));
});

// Reads every schedule page again, e.g. after a failed page or a new model. Costs a model call per page.
schedules.post("/api/projects/:id/schedules/refresh", requireRole("admin"), requireProjectAccess(), rateLimit(limiters.chat), async (c) => {
  await sql`update pages set schedule_version = null, schedule_error = null where project_id = ${c.req.param("id")}`;
  return c.json(await projectSchedule(c.req.param("id")), 202);
});
