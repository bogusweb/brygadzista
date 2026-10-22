import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { documentDir, documentPdf, pageImage } from "../src/storage.js";
import { ADMIN, APP, createDocument, createProject, makePdf, resetDatabase } from "./helpers.js";

const upload = (projectId: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = ADMIN, query = "") =>
  app.request(`/api/projects/${projectId}/documents?filename=hala.pdf${query}`, { method: "PUT", body, headers });

const defaultLimits = { maxUploadBytes: config.maxUploadBytes, maxPages: config.maxPages };

let projectId: string;

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
});

afterEach(() => {
  Object.assign(config, defaultLimits);
});

afterAll(async () => {
  await sql.end();
});

describe("upload", () => {
  it("rejects a file that is not a PDF and leaves nothing behind", async () => {
    const response = await upload(projectId, new TextEncoder().encode("PK\u0003\u0004 to jest zip"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "To nie jest plik PDF" });
    expect(await sql`select id from documents`).toHaveLength(0);
  });

  it("stores a PDF on disk and queues it for indexing", async () => {
    const pdf = makePdf(["Opis techniczny"]);

    const response = await upload(projectId, pdf);

    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const [doc] = await sql`select filename, status, project_id from documents where id = ${id}`;
    expect(doc).toMatchObject({ filename: "hala.pdf", status: "queued", project_id: projectId });
    expect(new Uint8Array(await readFile(await documentPdf(id)))).toEqual(pdf);
  });

  it("lists the uploaded document for the app", async () => {
    await upload(projectId, makePdf(["Opis techniczny"]));

    const response = await app.request(`/api/projects/${projectId}/documents`, { headers: APP });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ filename: "hala.pdf", status: "queued", pageCount: 1, failedPages: 0, progress: null }),
    ]);
  });

  it("returns the page count and a cost and time estimate right after upload", async () => {
    const response = await upload(projectId, makePdf(Array.from({ length: 12 }, (_, i) => `Strona ${i + 1}`)));

    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string; pageCount: number; estimate: { pages: number; costUsd: number; seconds: number } };
    expect(body).toMatchObject({ status: "queued", pageCount: 12, estimate: { pages: 12 } });
    expect(body.estimate.seconds).toBeGreaterThan(0);
  });

  it("with autostart=0 waits for a confirmation from the dashboard", async () => {
    const response = await upload(projectId, makePdf(["Opis techniczny"]), ADMIN, "&autostart=0");
    const { id, status } = (await response.json()) as { id: string; status: string };
    expect(status).toBe("awaiting_start");

    const start = () => app.request(`/api/documents/${id}/start`, { method: "POST", headers: ADMIN });
    expect((await app.request(`/api/documents/${id}/start`, { method: "POST", headers: APP })).status).toBe(401);
    expect((await start()).status).toBe(200);
    const [doc] = await sql`select status from documents where id = ${id}`;
    expect(doc).toEqual({ status: "queued" });
    expect((await start()).status).toBe(409);
  });

  it("cuts off a file over the size limit while streaming and leaves nothing behind", async () => {
    config.maxUploadBytes = 1024;
    const pdf = makePdf(Array.from({ length: 30 }, (_, i) => `Strona ${i + 1}`));
    expect(pdf.length).toBeGreaterThan(1024);

    const documentDirs = () => readdir(path.join(config.dataDir, "documents")).catch(() => []);
    const before = await documentDirs();

    const response = await upload(projectId, pdf);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Plik jest za duży") });
    expect(await sql`select id from documents`).toHaveLength(0);
    expect(await documentDirs()).toEqual(before);
  });

  it("rejects a declared Content-Length over the limit before reading the body", async () => {
    config.maxUploadBytes = 1024;

    const response = await upload(projectId, makePdf(["x"]), { ...ADMIN, "content-length": String(10 * 1024 * 1024) });

    expect(response.status).toBe(413);
    expect(await sql`select id from documents`).toHaveLength(0);
  });

  it("rejects a PDF with more pages than the limit", async () => {
    config.maxPages = 5;

    const response = await upload(projectId, makePdf(Array.from({ length: 6 }, (_, i) => `Strona ${i + 1}`)));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "PDF ma 6 stron, limit to 5" });
    expect(await sql`select id from documents`).toHaveLength(0);
  });

  it("rejects a file that starts like a PDF but cannot be read", async () => {
    const response = await upload(projectId, new TextEncoder().encode("%PDF-1.4 to nie jest prawdziwy PDF"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Nie udało się odczytać PDF" });
    expect(await sql`select id from documents`).toHaveLength(0);
  });
});

describe("progress", () => {
  it("reports pages done and time left for a document being indexed", async () => {
    const documentId = await createDocument(projectId, "processing");
    await sql`update documents set page_count = 300, run_total = 300, run_done = 60,
      started_at = now() - interval '120 seconds' where id = ${documentId}`;

    const response = await app.request(`/api/documents/${documentId}`, { headers: APP });

    expect(response.status).toBe(200);
    const { progress } = (await response.json()) as { progress: { total: number; done: number; etaSeconds: number } };
    expect(progress).toMatchObject({ total: 300, done: 60 });
    // 2 s per page so far, 240 pages left.
    expect(progress.etaSeconds).toBeGreaterThanOrEqual(480);
    expect(progress.etaSeconds).toBeLessThan(490);
  });

  it("returns 404 for an unknown document", async () => {
    const response = await app.request("/api/documents/00000000-0000-0000-0000-000000000000", { headers: APP });
    expect(response.status).toBe(404);
  });
});

describe("authorization", () => {
  it("lets anyone check health", async () => {
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("rejects requests without a token or with a wrong one", async () => {
    expect((await app.request("/api/projects")).status).toBe(401);
    expect((await app.request("/api/projects", { headers: { authorization: "Bearer zly" } })).status).toBe(401);
  });

  it("does not let the app role upload, create or delete", async () => {
    expect((await upload(projectId, makePdf(["x"]), APP)).status).toBe(401);
    expect(
      (await app.request("/api/projects", { method: "POST", headers: { ...APP, "content-type": "application/json" }, body: '{"name":"X"}' }))
        .status,
    ).toBe(401);
    expect((await app.request(`/api/projects/${projectId}`, { method: "DELETE", headers: APP })).status).toBe(401);
    expect(await sql`select id from documents`).toHaveLength(0);
    expect(await sql`select id from projects`).toHaveLength(1);
  });

  it("lets the app role read projects", async () => {
    const response = await app.request("/api/projects", { headers: APP });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ id: projectId, name: "Hala sportowa", documentCount: 0 })]);
  });

  it("accepts ?token= for page images", async () => {
    const documentId = await createDocument(projectId, "ready");
    await mkdir(await documentDir(documentId), { recursive: true });
    await writeFile(await pageImage(documentId, 1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const response = await app.request(`/api/documents/${documentId}/pages/1/image?token=test-app`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("rejects ?token= with a wrong token on page images", async () => {
    const documentId = await createDocument(projectId, "ready");

    expect((await app.request(`/api/documents/${documentId}/pages/1/image?token=zly`)).status).toBe(401);
  });

  it("ignores ?token= everywhere except page images", async () => {
    expect((await app.request("/api/projects?token=test-admin")).status).toBe(401);
    expect((await upload(projectId, makePdf(["x"]), {})).status).toBe(401);
    expect(
      (await app.request(`/api/projects/${projectId}/documents?filename=a.pdf&token=test-admin`, { method: "PUT", body: makePdf(["x"]) })).status,
    ).toBe(401);
    expect((await app.request("/api/copilotkit/info?token=test-app", { method: "POST" })).status).toBe(401);
  });

  it("keeps the admin agent endpoint away from the app role", async () => {
    expect((await app.request("/api/admin/copilotkit/info", { method: "POST", headers: APP })).status).toBe(401);
  });
});
