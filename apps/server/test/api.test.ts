import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { documentDir, documentPdf, pageImage } from "../src/storage.js";
import { ADMIN, APP, createDocument, createProject, makePdf, resetDatabase } from "./helpers.js";

const upload = (projectId: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = ADMIN) =>
  app.request(`/api/projects/${projectId}/documents?filename=hala.pdf`, { method: "PUT", body, headers });

let projectId: string;

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
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
    expect(new Uint8Array(await readFile(documentPdf(id)))).toEqual(pdf);
  });

  it("lists the uploaded document for the app", async () => {
    await upload(projectId, makePdf(["Opis techniczny"]));

    const response = await app.request(`/api/projects/${projectId}/documents`, { headers: APP });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ filename: "hala.pdf", status: "queued", pageCount: 0 })]);
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
    await mkdir(documentDir(documentId), { recursive: true });
    await writeFile(pageImage(documentId, 1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

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
