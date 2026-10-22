import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { photoFile } from "../src/storage.js";
import { ADMIN, APP, createDocument, createProject, createTenant, createUser, login, resetDatabase } from "./helpers.js";

let projectId: string;
let documentId: string;

const json = (body: unknown, headers: Record<string, string>) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { ...headers, "content-type": "application/json" },
});

const addPhoto = async (takenAt: string) => {
  const [pin] = await sql<{ id: string }[]>`
    insert into pins (id, project_id, document_id, page_no, x, y, kind, note, created_at, updated_at)
    values (gen_random_uuid(), ${projectId}, ${documentId}, 1, 0.5, 0.5, 'photo', 'Zbrojenie ławy', ${takenAt}, ${takenAt}) returning id`;
  const [photo] = await sql<{ id: string }[]>`
    insert into pin_photos (id, pin_id, project_id, width, height, bytes, taken_at)
    values (gen_random_uuid(), ${pin!.id}, ${projectId}, 10, 10, 100, ${takenAt}) returning id`;
  const file = await photoFile(projectId, photo!.id, "thumb");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await sharp({ create: { width: 10, height: 10, channels: 3, background: "#888" } }).jpeg().toBuffer());
  return photo!.id;
};

const createReport = async (headers: Record<string, string> = APP) => {
  const response = await app.request(`/api/projects/${projectId}/reports`, json({ weekStart: "2026-10-21" }, headers));
  return { response, report: (await response.json()) as { id: string; periodStart: string; periodEnd: string; summary: { paragraphs: { text: string }[] } } };
};

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject("Dom w Piławie");
  documentId = await createDocument(projectId, "ready");
  await sql`insert into diary_entries (project_id, entry_date, source, transcript, status, entry)
    values (${projectId}, '2026-10-20', 'text', 'x', 'ready', ${sql.json({ summary: "Ławy", work: ["Zabetonowano ławy"], people: [], crew: [], deliveries: [], weather: null, problems: [], references: [] })})`;
});

afterAll(async () => {
  await sql.end();
});

describe("weekly report", () => {
  it("is made for the week of the given day, replaced when made again, and listed", async () => {
    const { response, report } = await createReport();
    expect(response.status).toBe(201);
    expect(report).toMatchObject({ periodStart: "2026-10-19", periodEnd: "2026-10-25" });
    expect(report.summary.paragraphs[0]!.text).toContain("Zabetonowano ławy");
    const again = await createReport();
    expect(again.report.id).toBe(report.id);
    const list = (await (await app.request(`/api/projects/${projectId}/reports`, { headers: APP })).json()) as unknown[];
    expect(list).toHaveLength(1);
    const pdf = await app.request(`/api/reports/${report.id}/report.pdf?token=test-app`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses a week that has not started", async () => {
    const response = await app.request(`/api/projects/${projectId}/reports`, json({ weekStart: "2099-01-05" }, APP));
    expect(response.status).toBe(400);
  });

  it("is not visible to another firm", async () => {
    const { report } = await createReport();
    const other = await createTenant("Inna firma");
    await createUser("szef@inna.pl", "owner", undefined, other);
    const headers = await login("szef@inna.pl");
    expect((await app.request(`/api/reports/${report.id}`, { headers })).status).toBe(404);
    expect((await app.request(`/api/reports/${report.id}/share`, json({}, headers))).status).toBe(404);
  });
});

describe("read-only link", () => {
  it("opens the report and its own photos without logging in, and nothing else", async () => {
    const inWeek = await addPhoto("2026-10-21T09:00:00Z");
    const outside = await addPhoto("2026-10-01T09:00:00Z");
    const { report } = await createReport();
    const shared = await app.request(`/api/reports/${report.id}/share`, { ...json({ days: 14 }, ADMIN), headers: { ...ADMIN, "content-type": "application/json", host: "brygadzista.example", "x-forwarded-proto": "https" } });
    expect(shared.status).toBe(201);
    const { url } = (await shared.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/brygadzista\.example\/r\/bl_/);
    const token = url.split("/r/")[1]!;

    const page = await app.request(`/r/${token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Zabetonowano ławy");
    expect(html).toContain(`/r/${token}/photos/${inWeek}`);
    expect((await app.request(`/r/${token}/photos/${inWeek}`)).status).toBe(200);
    expect((await app.request(`/r/${token}/photos/${outside}`)).status).toBe(404);
    expect((await app.request(`/r/${token}/report.pdf`)).headers.get("content-type")).toBe("application/pdf");

    await sql`update share_links set expires_at = now() - interval '1 minute'`;
    expect((await app.request(`/r/${token}`)).status).toBe(404);
    expect((await app.request("/r/bl_nieistniejacytokentokentoken")).status).toBe(404);
  });

  it("is made by owners and managers only, and stops working when the report is deleted", async () => {
    await createUser("brygadzista@example.com", "worker");
    const worker = await login("brygadzista@example.com");
    const { report } = await createReport();
    expect((await app.request(`/api/reports/${report.id}/share`, json({}, worker))).status).toBe(401);
    const { url } = (await (await app.request(`/api/reports/${report.id}/share`, json({}, ADMIN))).json()) as { url: string };
    expect((await app.request(`/api/reports/${report.id}`, { method: "DELETE", headers: ADMIN })).status).toBe(204);
    expect((await app.request(new URL(url).pathname)).status).toBe(404);
  });
});
