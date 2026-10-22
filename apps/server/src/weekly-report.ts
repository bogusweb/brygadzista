import { generateText, Output } from "ai";
import { z } from "zod";
import { config } from "./config.js";
import { sql } from "./db.js";
import { diaryEntrySchema, type DiaryEntry } from "./diary-entry.js";
import { dayCrew } from "./diary-report.js";
import { agentLanguageModel, callModel } from "./llm.js";
import { STATUS_LABELS } from "./defects.js";
import type { DefectStatus } from "./pins.js";
import { MARGIN, bulletSection, createPdf, formatDay, formatIsoDay, imageRows, photoThumb, planCrop } from "./report-pdf.js";

// The weekly report for the investor (#84): what was done (daily log), photos from the drawings, defects opened and
// closed, finished checklists, and a short summary by the model that points to those sources. The facts are
// collected once into a snapshot, so the report sent to the investor does not change when the site data does.

export type ReportSource = { id: string; label: string };

export type WeeklySnapshot = {
  projectName: string;
  siteAddress: string | null;
  from: string;
  to: string;
  days: { date: string; crewTotal: number; work: string[]; problems: string[]; sourceId: string }[];
  deliveries: string[];
  photos: { id: string; takenAt: string; caption: string; documentId: string; pageNo: number; pageTitle: string | null; x: number; y: number }[];
  defects: {
    opened: WeeklyDefect[];
    closed: WeeklyDefect[];
    openTotal: number;
    overdue: number;
  };
  checklists: { title: string; completedAt: string; completedBy: string; checked: number; total: number; sourceId: string }[];
};

export type WeeklyDefect = {
  id: string;
  title: string;
  status: DefectStatus;
  assignee: string;
  pageNo: number;
  pageTitle: string | null;
  sourceId: string;
};

export type WeeklySummary = { paragraphs: { text: string; sources: string[] }[]; byModel: boolean };

const MAX_PHOTOS = 24;

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// Monday of the week the day falls in.
export const weekStart = (day: string) => {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
};

export const weekEnd = (start: string) => addDays(start, 6);

// Site days are Warsaw days: a photo taken at 00:30 on Monday belongs to Monday.
const inWeek = (column: "ph.taken_at" | "p.created_at" | "p.closed_at" | "r.completed_at", from: string, to: string) =>
  sql`(${sql.unsafe(column)} at time zone 'Europe/Warsaw')::date between ${from}::date and ${to}::date`;

const defectTitle = (row: { room: string; note: string; pageTitle: string | null; pageNo: number }) =>
  (row.room || row.note || row.pageTitle || `Strona ${row.pageNo}`).slice(0, 120);

export const collectWeek = async (projectId: string, from: string): Promise<WeeklySnapshot> => {
  const to = weekEnd(from);
  const [project] = await sql<{ name: string; siteAddress: string | null }[]>`
    select name, null::text as "siteAddress" from projects where id = ${projectId}`;

  const entries = await sql<{ entryDate: string; entry: unknown }[]>`
    select entry_date::text as "entryDate", entry from diary_entries
    where project_id = ${projectId} and status = 'ready' and entry is not null and entry_date between ${from}::date and ${to}::date
    order by entry_date, created_at`;
  const byDay = new Map<string, DiaryEntry[]>();
  for (const row of entries) {
    const parsed = diaryEntrySchema.safeParse(row.entry);
    if (parsed.success) byDay.set(row.entryDate, [...(byDay.get(row.entryDate) ?? []), parsed.data]);
  }
  const days = [...byDay].map(([date, dayEntries], index) => ({
    date,
    crewTotal: dayCrew(dayEntries).reduce((sum, member) => sum + member.count, 0),
    work: dayEntries.flatMap((entry) => entry.work),
    problems: dayEntries.flatMap((entry) => entry.problems),
    sourceId: `D${index + 1}`,
  }));

  const photos = await sql<WeeklySnapshot["photos"]>`
    select ph.id, ph.taken_at as "takenAt", coalesce(nullif(p.note, ''), nullif(p.room, ''), '') as caption,
      p.document_id as "documentId", p.page_no as "pageNo", pg.title as "pageTitle", p.x, p.y
    from pin_photos ph join pins p on p.id = ph.pin_id
      left join pages pg on pg.document_id = p.document_id and pg.page_no = p.page_no
    where ph.project_id = ${projectId} and ${inWeek("ph.taken_at", from, to)}
    order by ph.taken_at limit ${MAX_PHOTOS}`;

  type DefectRow = { id: string; room: string; note: string; status: DefectStatus | null; assignee: string; pageNo: number; pageTitle: string | null };
  const defectRows = (event: "opened" | "closed") => sql<DefectRow[]>`
    select p.id, p.room, p.note, p.status, p.assignee, p.page_no as "pageNo", pg.title as "pageTitle"
    from pins p left join pages pg on pg.document_id = p.document_id and pg.page_no = p.page_no
    where p.project_id = ${projectId} and p.kind = 'defect'
      and ${event === "opened" ? inWeek("p.created_at", from, to) : sql`p.status = 'closed' and ${inWeek("p.closed_at", from, to)}`}
    order by p.created_at`;
  const opened = await defectRows("opened");
  const closed = await defectRows("closed");
  const [totals] = await sql<{ open: number; overdue: number }[]>`
    select count(*) filter (where status <> 'closed')::int as open,
      count(*) filter (where status <> 'closed' and due_date < ${to}::date)::int as overdue
    from pins where project_id = ${projectId} and kind = 'defect'`;
  let defectIndex = 0;
  const defect = (row: DefectRow): WeeklyDefect => ({
    id: row.id,
    title: defectTitle(row),
    status: row.status ?? "open",
    assignee: row.assignee,
    pageNo: row.pageNo,
    pageTitle: row.pageTitle,
    sourceId: `U${++defectIndex}`,
  });

  const results = await sql<{ title: string; completedAt: Date; completedBy: string; items: { checked: boolean }[] }[]>`
    select c.title, r.completed_at as "completedAt", r.completed_by_name as "completedBy", r.items
    from checklist_results r join checklists c on c.id = r.checklist_id
    where c.project_id = ${projectId} and ${inWeek("r.completed_at", from, to)} order by r.completed_at`;

  return {
    projectName: project?.name ?? "",
    siteAddress: project?.siteAddress ?? null,
    from,
    to,
    days,
    deliveries: [...byDay.values()].flat().flatMap((entry) => entry.deliveries),
    photos: photos.map((photo) => ({ ...photo, takenAt: new Date(photo.takenAt).toISOString() })),
    defects: { opened: opened.map(defect), closed: closed.map(defect), openTotal: totals?.open ?? 0, overdue: totals?.overdue ?? 0 },
    checklists: results.map((result, index) => ({
      title: result.title,
      completedAt: new Date(result.completedAt).toISOString(),
      completedBy: result.completedBy,
      checked: result.items.filter((item) => item.checked).length,
      total: result.items.length,
      sourceId: `C${index + 1}`,
    })),
  };
};

// Every fact the summary may cite, with the short id it cites it by.
export const reportSources = (week: WeeklySnapshot): ReportSource[] => [
  ...week.days.map((day) => ({
    id: day.sourceId,
    label: `Dziennik ${formatIsoDay(day.date)}${day.crewTotal ? `, ${day.crewTotal} os.` : ""}: ${[...day.work, ...day.problems.map((problem) => `problem: ${problem}`)].join("; ")}`,
  })),
  ...[...week.defects.opened.map((defect) => ({ defect, event: "zgłoszona" })), ...week.defects.closed.map((defect) => ({ defect, event: "zamknięta" }))].map(
    ({ defect, event }) => ({ id: defect.sourceId, label: `Usterka ${event}: ${defect.title} (${defect.pageTitle ?? `str. ${defect.pageNo}`})` }),
  ),
  ...week.checklists.map((list) => ({ id: list.sourceId, label: `Checklista „${list.title}” zamknięta: ${list.checked}/${list.total} punktów` })),
];

const summarySchema = z.object({
  paragraphs: z
    .array(
      z.object({
        text: z.string().describe("2–4 zdania po polsku, rzeczowo, dla inwestora (nie dla ekipy)."),
        sources: z.array(z.string()).describe("Identyfikatory źródeł z listy (np. D1, U2, C1), na których oparto akapit."),
      }),
    )
    .describe("Od 1 do 3 akapitów: postęp prac, usterki i odbiory, co dalej lub co wymaga decyzji inwestora."),
});

// Without a key, or with FAKE_AGENT, the summary is plain counts, so the report still goes out.
export const plainSummary = (week: WeeklySnapshot): WeeklySummary => {
  const work = week.days.flatMap((day) => day.work);
  const paragraphs = [
    {
      text: week.days.length
        ? `W tym tygodniu zapisano ${week.days.length} dni pracy w dzienniku. ${work.slice(0, 3).join(". ")}${work.length ? "." : ""}`
        : "W tym tygodniu nie ma wpisów w dzienniku budowy.",
      sources: week.days.map((day) => day.sourceId),
    },
    {
      text:
        `Usterki: zgłoszono ${week.defects.opened.length}, zamknięto ${week.defects.closed.length}, otwartych jest ${week.defects.openTotal}` +
        `${week.defects.overdue ? `, w tym ${week.defects.overdue} po terminie` : ""}.` +
        (week.checklists.length ? ` Zamknięte checklisty: ${week.checklists.map((list) => list.title).join(", ")}.` : ""),
      sources: [...week.defects.opened, ...week.defects.closed].map((defect) => defect.sourceId).concat(week.checklists.map((list) => list.sourceId)),
    },
  ];
  return { paragraphs, byModel: false };
};

export const summarizeWeek = async (week: WeeklySnapshot): Promise<WeeklySummary> => {
  const sources = reportSources(week);
  if (config.fakeAgent || !config.openrouterApiKey || sources.length === 0) return plainSummary(week);
  const known = new Set(sources.map((source) => source.id));
  try {
    const { output } = await callModel("weekly summary", (abortSignal) =>
      generateText({
        model: agentLanguageModel(),
        abortSignal,
        maxRetries: 0,
        output: Output.object({ schema: summarySchema }),
        prompt:
          "Napisz krótkie podsumowanie tygodnia na budowie dla inwestora. Opieraj się wyłącznie na źródłach z listy, " +
          "niczego nie dopowiadaj. Przy każdym akapicie podaj identyfikatory źródeł, z których korzystasz.\n\n" +
          `Tydzień: ${formatIsoDay(week.from)} – ${formatIsoDay(week.to)}. Otwartych usterek łącznie: ${week.defects.openTotal}` +
          `${week.defects.overdue ? `, po terminie: ${week.defects.overdue}` : ""}.\n\nŹródła:\n` +
          sources.map((source) => `[${source.id}] ${source.label}`).join("\n"),
      }),
    );
    const paragraphs = output.paragraphs
      .slice(0, 3)
      .map((paragraph) => ({ text: paragraph.text.trim().slice(0, 1200), sources: [...new Set(paragraph.sources.filter((id) => known.has(id)))] }))
      .filter((paragraph) => paragraph.text);
    return paragraphs.length ? { paragraphs, byModel: true } : plainSummary(week);
  } catch (error) {
    console.error("weekly report: summary failed, using counts", error);
    return plainSummary(week);
  }
};

// --- PDF ---

export const weeklyReportPdf = async (projectId: string, week: WeeklySnapshot, summary: WeeklySummary, link: { url: string; qr: Buffer } | null) => {
  const pdf = createPdf(`Raport tygodniowy – ${week.projectName}`);
  const { doc, width } = pdf;
  doc.font("bold").fontSize(18).fillColor("#111111").text("Raport tygodniowy z budowy");
  doc.font("regular").fontSize(11).fillColor("#333333").text(week.projectName || "Projekt");
  if (week.siteAddress) doc.text(week.siteAddress);
  doc.text(`${formatIsoDay(week.from)} – ${formatIsoDay(week.to)}`);
  if (link) {
    doc.image(link.qr, MARGIN + width - 80, MARGIN, { fit: [80, 80] });
    doc.fontSize(8).fillColor("#666666").text("Wersja online", MARGIN + width - 80, MARGIN + 82, { width: 80, align: "center" });
    doc.x = MARGIN;
    doc.y = Math.max(doc.y, MARGIN + 100);
  }
  doc.moveDown();

  doc.font("bold").fontSize(13).fillColor("#111111").text("Podsumowanie");
  for (const paragraph of summary.paragraphs) {
    doc.moveDown(0.3).font("regular").fontSize(10.5).fillColor("#222222").text(paragraph.text, { width, continued: paragraph.sources.length > 0 });
    if (paragraph.sources.length) doc.fillColor("#1F4E79").text(`  [${paragraph.sources.join(", ")}]`);
  }
  doc.font("regular").fontSize(8.5).fillColor("#777777").moveDown(0.3).text(
    summary.byModel ? "Podsumowanie napisał asystent na podstawie źródeł poniżej (oznaczenia w nawiasach)." : "Podsumowanie wyliczone z danych poniżej.",
  );

  doc.moveDown(0.5);
  pdf.rule();
  doc.moveDown(0.5).font("bold").fontSize(13).fillColor("#111111").text("Wykonane prace");
  if (week.days.length === 0) doc.font("regular").fontSize(10.5).text("Brak wpisów w dzienniku.");
  for (const day of week.days) {
    bulletSection(pdf, `[${day.sourceId}] ${formatIsoDay(day.date)}${day.crewTotal ? ` · ${day.crewTotal} os.` : ""}`, [
      ...day.work,
      ...day.problems.map((problem) => `Problem: ${problem}`),
    ]);
  }
  bulletSection(pdf, "Dostawy", week.deliveries);

  doc.moveDown(0.5);
  pdf.rule();
  doc.moveDown(0.5).font("bold").fontSize(13).fillColor("#111111").text("Usterki");
  doc.font("regular").fontSize(10.5).fillColor("#222222").text(
    `Zgłoszone w tygodniu: ${week.defects.opened.length} · zamknięte: ${week.defects.closed.length} · otwarte łącznie: ${week.defects.openTotal}` +
      (week.defects.overdue ? ` · po terminie: ${week.defects.overdue}` : ""),
  );
  const defectLine = (defect: WeeklyDefect) =>
    `[${defect.sourceId}] ${defect.title} – ${STATUS_LABELS[defect.status].toLowerCase()}, ${defect.pageTitle ?? `str. ${defect.pageNo}`}${defect.assignee ? `, ${defect.assignee}` : ""}`;
  bulletSection(pdf, "Zgłoszone", week.defects.opened.map(defectLine));
  bulletSection(pdf, "Zamknięte", week.defects.closed.map(defectLine));

  if (week.checklists.length) {
    doc.moveDown(0.5);
    pdf.rule();
    doc.moveDown(0.5).font("bold").fontSize(13).fillColor("#111111").text("Checklisty");
    bulletSection(
      pdf,
      "Zamknięte w tygodniu",
      week.checklists.map((list) => `[${list.sourceId}] ${list.title}: ${list.checked}/${list.total} · ${formatDay(list.completedAt)}${list.completedBy ? `, ${list.completedBy}` : ""}`),
    );
  }

  if (week.photos.length) {
    doc.moveDown(0.5);
    pdf.rule();
    doc.moveDown(0.5).font("bold").fontSize(13).fillColor("#111111").text("Zdjęcia z budowy");
    doc.moveDown(0.3);
    const images = await Promise.all(
      week.photos.map(async (photo) => ({
        label: `${formatDay(photo.takenAt)} · ${photo.caption || photo.pageTitle || `str. ${photo.pageNo}`}`.slice(0, 60),
        image: (await photoThumb(projectId, photo.id)) ?? (await planCrop(photo.documentId, photo.pageNo, photo.x, photo.y)),
      })),
    );
    imageRows(pdf, images.flatMap(({ label, image }) => (image ? [{ label, image }] : [])), 110);
  }
  if (link) doc.moveDown().font("regular").fontSize(9).fillColor("#555555").text(`Wersja online: ${link.url}`, MARGIN, doc.y, { width, link: link.url });
  return pdf.finish();
};
