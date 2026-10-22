import { Hono, type MiddlewareHandler } from "hono";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { canAccessProject, isUuid, requireProjectAccess, requireRole, requireRoleOrQueryToken, type AuthEnv } from "./auth.js";
import { sql, withTenant } from "./db.js";
import { STATUS_LABELS } from "./defects.js";
import { limiters, rateLimit } from "./rate-limit.js";
import { exists, formatDay, formatIsoDay } from "./report-pdf.js";
import { createShareLink, escapeHtml, notFoundPage, publicOrigin, publicPage, resolveShareLink, shareDays } from "./share.js";
import { warsawToday } from "./site.js";
import { photoFile } from "./storage.js";
import { collectWeek, summarizeWeek, weekEnd, weekStart, weeklyReportPdf, type WeeklySnapshot, type WeeklySummary } from "./weekly-report.js";

// Weekly reports for the investor (#84): made on request from the week's data, kept as made, downloaded as a PDF
// and sent as a read-only link that opens on any phone.

type ReportRow = {
  id: string;
  projectId: string;
  periodStart: string;
  periodEnd: string;
  snapshot: WeeklySnapshot;
  summary: WeeklySummary;
  createdByName: string;
  createdAt: Date;
};

const reportColumns = sql`
  id, project_id as "projectId", period_start::text as "periodStart", period_end::text as "periodEnd", snapshot, summary,
  created_by_name as "createdByName", created_at as "createdAt"`;

const reportById = async (id: string) => {
  if (!isUuid(id)) return null;
  const [row] = await sql<ReportRow[]>`select ${reportColumns} from reports where id = ${id}`;
  return row ?? null;
};

const publicReport = ({ projectId: _projectId, ...row }: ReportRow) => row;

const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

const requireReportAccess: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const report = await reportById(c.req.param("id") ?? "");
  const tenantId = report ? await canAccessProject(c.get("principal"), report.projectId) : null;
  if (!tenantId) return c.json({ error: "Nie ma takiego raportu" }, 404);
  await withTenant(tenantId, next);
};

const pdfResponse = (pdf: Buffer, filename: string) =>
  new Response(new Uint8Array(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${filename}"`, "cache-control": "no-store" },
  });

const pdfName = (report: ReportRow) => `raport-${report.periodStart}.pdf`;

export const reports = new Hono<AuthEnv>();

reports.get("/api/projects/:id/reports", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const rows = await sql<Pick<ReportRow, "id" | "periodStart" | "periodEnd" | "createdByName" | "createdAt">[]>`
    select id, period_start::text as "periodStart", period_end::text as "periodEnd", created_by_name as "createdByName", created_at as "createdAt"
    from reports where project_id = ${c.req.param("id")} order by period_start desc`;
  return c.json(rows);
});

// Made again for the same week, a report replaces the old one: the investor gets what is true now. The summary is a
// model call, so it counts against the chat limit.
reports.post("/api/projects/:id/reports", requireRole("app", "admin"), requireProjectAccess(), rateLimit(limiters.chat), async (c) => {
  const body = await c.req.json<{ weekStart?: unknown }>().catch(() => ({}) as { weekStart?: unknown });
  const day = body.weekStart ?? warsawToday();
  if (!isDate(day)) return c.json({ error: "Nieprawidłowa data tygodnia" }, 400);
  const from = weekStart(day);
  if (from > warsawToday()) return c.json({ error: "Ten tydzień jeszcze się nie zaczął" }, 400);
  const projectId = c.req.param("id");
  const snapshot = await collectWeek(projectId, from);
  const summary = await summarizeWeek(snapshot);
  const { user } = c.get("principal");
  const [row] = await sql<{ id: string }[]>`
    insert into reports (project_id, period_start, period_end, snapshot, summary, created_by, created_by_name)
    values (${projectId}, ${from}, ${weekEnd(from)}, ${sql.json(snapshot)}, ${sql.json(summary)}, ${user?.id ?? null}, ${user ? user.name || user.email : ""})
    on conflict (project_id, kind, period_start) do update set snapshot = excluded.snapshot, summary = excluded.summary,
      created_by = excluded.created_by, created_by_name = excluded.created_by_name, created_at = now()
    returning id`;
  return c.json(publicReport((await reportById(row!.id))!), 201);
});

reports.get("/api/reports/:id", requireRole("app", "admin"), requireReportAccess, async (c) => c.json(publicReport((await reportById(c.req.param("id")))!)));

reports.get("/api/reports/:id/report.pdf", requireRoleOrQueryToken("app", "admin"), requireReportAccess, async (c) => {
  const report = (await reportById(c.req.param("id")))!;
  return pdfResponse(await weeklyReportPdf(report.projectId, report.snapshot, report.summary, null), pdfName(report));
});

// A link for the investor, e.g. to paste into WhatsApp. Sharing outside the firm is for owners and managers.
reports.post("/api/reports/:id/share", requireRole("admin"), requireReportAccess, async (c) => {
  const body = await c.req.json<{ days?: unknown }>().catch(() => ({}) as { days?: unknown });
  const report = (await reportById(c.req.param("id")))!;
  const { token, expiresAt } = await createShareLink(report.projectId, { type: "report", id: report.id }, c.get("principal").user?.id ?? null, shareDays(body.days));
  return c.json({ url: `${publicOrigin(c)}/r/${token}`, expiresAt }, 201);
});

reports.delete("/api/reports/:id", requireRole("admin"), requireReportAccess, async (c) => {
  await sql`delete from reports where id = ${c.req.param("id")}`;
  await sql`delete from share_links where target_type = 'report' and target_id = ${c.req.param("id")}`;
  return c.body(null, 204);
});

// --- The investor's read-only view ---

const sharedReport = async (token: string) => {
  const link = await resolveShareLink(token, "report");
  const report = link ? await reportById(link.targetId) : null;
  return report && report.projectId === link?.projectId ? report : null;
};

const sources = (ids: string[]) => (ids.length ? ` <span class="src">[${ids.map(escapeHtml).join(", ")}]</span>` : "");

const list = (items: string[]) => (items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : "");

export const reportHtml = (report: ReportRow, token: string) => {
  const week = report.snapshot;
  const defectItem = (defect: WeeklySnapshot["defects"]["opened"][number]) =>
    `${escapeHtml(defect.title)} – <span class="status-${defect.status}">${STATUS_LABELS[defect.status].toLowerCase()}</span>, ` +
    `${escapeHtml(defect.pageTitle ?? `str. ${defect.pageNo}`)}${defect.assignee ? `, ${escapeHtml(defect.assignee)}` : ""}${sources([defect.sourceId])}`;
  const body = [
    `<h1>Raport tygodniowy z budowy</h1>`,
    `<p>${escapeHtml(week.projectName)}${week.siteAddress ? ` · ${escapeHtml(week.siteAddress)}` : ""}</p>`,
    `<p class="muted">${formatIsoDay(week.from)} – ${formatIsoDay(week.to)} · przygotowano ${formatDay(report.createdAt)}</p>`,
    `<p><a class="button" href="/r/${encodeURIComponent(token)}/report.pdf">Pobierz PDF</a></p>`,
    `<div class="card"><h2 style="margin-top:0">Podsumowanie</h2>`,
    ...report.summary.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph.text)}${sources(paragraph.sources)}</p>`),
    `<p class="muted">${report.summary.byModel ? "Podsumowanie napisał asystent na podstawie danych poniżej (oznaczenia w nawiasach)." : "Podsumowanie wyliczone z danych poniżej."}</p></div>`,
    `<h2>Wykonane prace</h2>`,
    week.days.length ? "" : `<p class="muted">Brak wpisów w dzienniku.</p>`,
    ...week.days.map(
      (day) =>
        `<h3>${formatIsoDay(day.date)}${day.crewTotal ? ` · ${day.crewTotal} os.` : ""}${sources([day.sourceId])}</h3>` +
        list([...day.work.map(escapeHtml), ...day.problems.map((problem) => `Problem: ${escapeHtml(problem)}`)]),
    ),
    week.deliveries.length ? `<h3>Dostawy</h3>${list(week.deliveries.map(escapeHtml))}` : "",
    `<h2>Usterki</h2>`,
    `<p>Zgłoszone w tygodniu: ${week.defects.opened.length} · zamknięte: ${week.defects.closed.length} · otwarte łącznie: ${week.defects.openTotal}` +
      `${week.defects.overdue ? ` · po terminie: ${week.defects.overdue}` : ""}</p>`,
    week.defects.opened.length ? `<h3>Zgłoszone</h3>${list(week.defects.opened.map(defectItem))}` : "",
    week.defects.closed.length ? `<h3>Zamknięte</h3>${list(week.defects.closed.map(defectItem))}` : "",
    week.checklists.length
      ? `<h2>Checklisty</h2>${list(
          week.checklists.map(
            (checklist) =>
              `${escapeHtml(checklist.title)}: ${checklist.checked}/${checklist.total} · ${formatDay(checklist.completedAt)}${checklist.completedBy ? `, ${escapeHtml(checklist.completedBy)}` : ""}${sources([checklist.sourceId])}`,
          ),
        )}`
      : "",
    week.photos.length
      ? `<h2>Zdjęcia z budowy</h2><div class="photos">${week.photos
          .map(
            (photo) =>
              `<figure><img loading="lazy" src="/r/${encodeURIComponent(token)}/photos/${photo.id}" alt=""><figcaption>${formatDay(photo.takenAt)} · ${escapeHtml(photo.caption || photo.pageTitle || `str. ${photo.pageNo}`)}</figcaption></figure>`,
          )
          .join("")}</div>`
      : "",
  ];
  return publicPage(`Raport tygodniowy – ${week.projectName}`, body.join("\n"));
};

reports.get("/r/:token", async (c) => {
  const report = await sharedReport(c.req.param("token"));
  if (!report) return c.html(notFoundPage(), 404);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(reportHtml(report, c.req.param("token")));
});

reports.get("/r/:token/report.pdf", async (c) => {
  const report = await sharedReport(c.req.param("token"));
  if (!report) return c.html(notFoundPage(), 404);
  return pdfResponse(await weeklyReportPdf(report.projectId, report.snapshot, report.summary, null), pdfName(report));
});

// Only photos that are in the report: the link opens nothing else on the project.
reports.get("/r/:token/photos/:photoId", async (c) => {
  const report = await sharedReport(c.req.param("token"));
  const photo = report?.snapshot.photos.find((candidate) => candidate.id === c.req.param("photoId"));
  const file = report && photo ? photoFile(report.projectId, photo.id, "thumb") : null;
  if (!file || !(await exists(file))) return c.body(null, 404);
  c.header("Content-Type", "image/jpeg");
  c.header("Cache-Control", "private, max-age=3600");
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
});
