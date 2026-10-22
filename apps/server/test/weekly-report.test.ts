import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "../src/db.js";
import { collectWeek, plainSummary, reportSources, weekEnd, weekStart, weeklyReportPdf } from "../src/weekly-report.js";
import { createDocument, createProject, resetDatabase } from "./helpers.js";

let projectId: string;
let documentId: string;

const entry = (work: string[], crew: { team: string; count: number }[] = []) => ({
  summary: work[0] ?? "",
  work,
  people: [],
  crew: crew.map((member) => ({ ...member, company: null })),
  deliveries: ["Bloczki, 2 palety"],
  weather: null,
  problems: [],
  references: [],
});

const addEntry = (day: string, value: unknown, status = "ready") =>
  sql`insert into diary_entries (project_id, entry_date, source, transcript, entry, status)
    values (${projectId}, ${day}, 'text', 'x', ${sql.json(value as never)}, ${status})`;

const addDefect = async (fields: { createdAt: string; updatedAt?: string; status: string; room: string; dueDate?: string }) => {
  const [pin] = await sql<{ id: string }[]>`
    insert into pins (id, project_id, document_id, page_no, x, y, kind, room, status, due_date, created_at, updated_at, closed_at)
    values (gen_random_uuid(), ${projectId}, ${documentId}, 1, 0.5, 0.5, 'defect', ${fields.room}, ${fields.status},
      ${fields.dueDate ?? null}, ${fields.createdAt}, ${fields.updatedAt ?? fields.createdAt},
      ${fields.status === "closed" ? (fields.updatedAt ?? fields.createdAt) : null}) returning id`;
  return pin!.id;
};

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject("Dom w Piławie");
  documentId = await createDocument(projectId, "ready");
});

afterAll(async () => {
  await sql.end();
});

describe("weekStart", () => {
  it("finds the Monday of the week", () => {
    expect(weekStart("2026-10-22")).toBe("2026-10-19");
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
    expect(weekStart("2026-10-25")).toBe("2026-10-19");
    expect(weekEnd("2026-10-19")).toBe("2026-10-25");
  });
});

describe("collectWeek", () => {
  it("gathers the week's log, defects and checklists, and nothing from other weeks", async () => {
    await addEntry("2026-10-20", entry(["Zabetonowano ławy"], [{ team: "zbrojarze", count: 4 }]));
    await addEntry("2026-10-20", entry(["Szalowanie ścian"], [{ team: "zbrojarze", count: 3 }, { team: "cieśle", count: 2 }]));
    await addEntry("2026-10-12", entry(["Wykop"]));
    await addEntry("2026-10-21", null, "error");
    await addDefect({ createdAt: "2026-10-20T08:00:00Z", status: "open", room: "Salon", dueDate: "2026-10-21" });
    await addDefect({ createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-22T08:00:00Z", status: "closed", room: "Kuchnia" });
    await addDefect({ createdAt: "2026-10-01T08:00:00Z", status: "open", room: "Łazienka" });
    const [list] = await sql<{ id: string }[]>`
      insert into checklists (project_id, stage, title, status) values (${projectId}, 'fundamenty', 'Fundamenty', 'ready') returning id`;
    await sql`insert into checklist_results (id, checklist_id, completed_at, completed_by_name, items)
      values (gen_random_uuid(), ${list!.id}, '2026-10-23T15:00:00Z', 'Jan', ${sql.json([{ checked: true }, { checked: false }])})`;

    const week = await collectWeek(projectId, "2026-10-19");

    expect(week.days).toEqual([
      { date: "2026-10-20", crewTotal: 6, work: ["Zabetonowano ławy", "Szalowanie ścian"], problems: [], sourceId: "D1" },
    ]);
    expect(week.defects.opened.map((defect) => defect.title)).toEqual(["Salon"]);
    expect(week.defects.closed.map((defect) => [defect.title, defect.sourceId])).toEqual([["Kuchnia", "U2"]]);
    expect(week.defects).toMatchObject({ openTotal: 2, overdue: 1 });
    expect(week.checklists).toMatchObject([{ title: "Fundamenty", checked: 1, total: 2, completedBy: "Jan", sourceId: "C1" }]);
    expect(reportSources(week).map((source) => source.id)).toEqual(["D1", "U1", "U2", "C1"]);

    const summary = plainSummary(week);
    expect(summary.paragraphs[1]!.text).toContain("zgłoszono 1, zamknięto 1, otwartych jest 2, w tym 1 po terminie");
    const pdf = await weeklyReportPdf(projectId, week, summary, null);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
