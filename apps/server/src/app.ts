import { serveStatic } from "@hono/node-server/serve-static";
import { CopilotRuntime, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createProjectAgent } from "./agent.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { estimateIndexing, etaSeconds } from "./estimate.js";
import { pdfPageCount } from "./pdf.js";
import { documentDir, documentPdf, pageImage } from "./storage.js";

type Role = "admin" | "app";

const roleForToken = (token: string | undefined): Role | null => {
  if (token === config.adminToken) return "admin";
  if (token === config.appToken) return "app";
  return null;
};

const bearerToken = (header: string | undefined) => header?.replace(/^Bearer\s+/i, "");

const authorize = (allowed: Role[], token: string | undefined): MiddlewareHandler => async (c, next) => {
  const role = roleForToken(token);
  if (!role || !allowed.includes(role)) return c.json({ error: "Brak dostępu" }, 401);
  await next();
};

const requireRole = (...allowed: Role[]): MiddlewareHandler => (c, next) =>
  authorize(allowed, bearerToken(c.req.header("authorization")))(c, next);

// <img src> cannot send headers, so page images also accept the token in ?token=. Nothing else does,
// because query strings end up in logs and browser history.
const requireRoleOrQueryToken = (...allowed: Role[]): MiddlewareHandler => (c, next) =>
  authorize(allowed, bearerToken(c.req.header("authorization")) ?? c.req.query("token"))(c, next);

const projectIdFrom = async (request: Request) => {
  const projectId = request.headers.get("x-project-id");
  if (!projectId) throw new Error("Brak nagłówka x-project-id");
  const [project] = await sql`select id from projects where id = ${projectId}`;
  if (!project) throw new Error("Nieznany projekt");
  return projectId;
};

// The mobile app gets plain tool-call UI; the dashboard additionally gets A2UI surfaces.
const appRuntime = new CopilotRuntime({
  agents: async ({ request }) => ({ default: createProjectAgent(await projectIdFrom(request)) }),
});
const adminRuntime = new CopilotRuntime({
  agents: async ({ request }) => ({ default: createProjectAgent(await projectIdFrom(request)) }),
  a2ui: { injectA2UITool: true },
});

export const app = new Hono();
app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-project-id"] }));

app.get("/api/health", (c) => c.json({ ok: true }));

app.use("/api/copilotkit/*", requireRole("app", "admin"));
app.route("/", createCopilotEndpoint({ runtime: appRuntime, basePath: "/api/copilotkit" }));
app.use("/api/admin/copilotkit/*", requireRole("admin"));
app.route("/", createCopilotEndpoint({ runtime: adminRuntime, basePath: "/api/admin/copilotkit" }));

app.get("/api/projects", requireRole("app", "admin"), async (c) =>
  c.json(await sql`
    select p.id, p.name, p.created_at as "createdAt",
      (select count(*)::int from documents d where d.project_id = p.id) as "documentCount"
    from projects p order by p.created_at desc`),
);

app.post("/api/projects", requireRole("admin"), async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: "Podaj nazwę projektu" }, 400);
  const [project] = await sql`insert into projects (name) values (${name.trim()}) returning id, name`;
  return c.json(project, 201);
});

app.delete("/api/projects/:id", requireRole("admin"), async (c) => {
  const documents = await sql<{ id: string }[]>`select id from documents where project_id = ${c.req.param("id")}`;
  await sql`delete from projects where id = ${c.req.param("id")}`;
  await Promise.all(documents.map((doc) => rm(documentDir(doc.id), { recursive: true, force: true })));
  return c.body(null, 204);
});

type DocumentRow = {
  id: string;
  filename: string;
  pageCount: number;
  indexedPages: number;
  status: string;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  runTotal: number;
  runDone: number;
  failedPages: number;
};

// What the dashboard needs to show before and during indexing: the estimate, progress and time left.
const withProgress = ({ startedAt, runTotal, runDone, ...doc }: DocumentRow) => ({
  ...doc,
  estimate: estimateIndexing(doc.pageCount),
  progress:
    doc.status === "processing"
      ? { total: runTotal, done: runDone, startedAt, etaSeconds: etaSeconds({ total: runTotal, done: runDone, startedAt }) }
      : null,
});

const documentRows = (where: ReturnType<typeof sql>) => sql<DocumentRow[]>`
  select d.id, d.filename, d.page_count as "pageCount", d.indexed_pages as "indexedPages", d.status, d.error,
    d.created_at as "createdAt", d.started_at as "startedAt", d.run_total as "runTotal", d.run_done as "runDone",
    (select count(*)::int from pages p where p.document_id = d.id and p.error is not null) as "failedPages"
  from documents d where ${where} order by d.created_at`;

app.get("/api/projects/:id/documents", requireRole("app", "admin"), async (c) =>
  c.json((await documentRows(sql`d.project_id = ${c.req.param("id")}`)).map(withProgress)),
);

app.get("/api/documents/:id", requireRole("app", "admin"), async (c) => {
  const [doc] = await documentRows(sql`d.id = ${c.req.param("id")}`);
  return doc ? c.json(withProgress(doc)) : c.json({ error: "Nie ma takiego dokumentu" }, 404);
});

class UploadTooLarge extends Error {}

// Counts bytes on the way to disk and stops the upload as soon as it passes the limit.
const limitSize = (maxBytes: number) => {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes ? new UploadTooLarge() : null, chunk);
    },
  });
};

const tooLargeMessage = () => `Plik jest za duży (limit ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`;

// The PDF is streamed straight to disk so large projects never sit in memory. The response carries the page
// count and a cost and time estimate; with ?autostart=0 indexing waits for POST /api/documents/:id/start.
app.put("/api/projects/:id/documents", requireRole("admin"), async (c) => {
  const filename = c.req.query("filename") ?? "projekt.pdf";
  const autostart = c.req.query("autostart") !== "0";
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Brak pliku" }, 400);
  if (Number(c.req.header("content-length") ?? 0) > config.maxUploadBytes) return c.json({ error: tooLargeMessage() }, 413);
  const [doc] = await sql<{ id: string }[]>`
    insert into documents (project_id, filename, status) values (${c.req.param("id")}, ${filename}, 'uploading') returning id`;
  const id = doc!.id;
  const reject = async (status: 400 | 413, error: string) => {
    await sql`delete from documents where id = ${id}`;
    await rm(documentDir(id), { recursive: true, force: true });
    return c.json({ error }, status);
  };

  await mkdir(documentDir(id), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream), limitSize(config.maxUploadBytes), createWriteStream(documentPdf(id)));
  } catch (error) {
    if (error instanceof UploadTooLarge) return reject(413, tooLargeMessage());
    await reject(400, "Przerwane wysyłanie pliku");
    throw error;
  }
  const handle = await open(documentPdf(id));
  const { buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
  await handle.close();
  if (buffer.toString() !== "%PDF-") return reject(400, "To nie jest plik PDF");
  const pageCount = await pdfPageCount(documentPdf(id)).catch(() => null);
  if (!pageCount) return reject(400, "Nie udało się odczytać PDF");
  if (pageCount > config.maxPages) return reject(413, `PDF ma ${pageCount} stron, limit to ${config.maxPages}`);

  const status = autostart ? "queued" : "awaiting_start";
  await sql`update documents set status = ${status}, page_count = ${pageCount} where id = ${id}`;
  return c.json({ id, status, pageCount, estimate: estimateIndexing(pageCount) }, 201);
});

app.post("/api/documents/:id/start", requireRole("admin"), async (c) => {
  const [doc] = await sql`
    update documents set status = 'queued' where id = ${c.req.param("id")} and status = 'awaiting_start' returning id`;
  return doc ? c.json({ ok: true }) : c.json({ error: "Dokument nie czeka na start" }, 409);
});

app.post("/api/documents/:id/reindex", requireRole("admin"), async (c) => {
  await sql`update pages set indexed = false where document_id = ${c.req.param("id")}`;
  await sql`update documents set status = 'queued', error = null where id = ${c.req.param("id")}`;
  return c.json({ ok: true });
});

app.delete("/api/documents/:id", requireRole("admin"), async (c) => {
  await sql`delete from documents where id = ${c.req.param("id")}`;
  await rm(documentDir(c.req.param("id")), { recursive: true, force: true });
  return c.body(null, 204);
});

app.get("/api/documents/:id/pages", requireRole("app", "admin"), async (c) =>
  c.json(await sql`
    select page_no as "pageNo", title, kind, summary, facts, indexed
    from pages where document_id = ${c.req.param("id")} order by page_no`),
);

app.get("/api/documents/:id/pages/:pageNo/image", requireRoleOrQueryToken("app", "admin"), async (c) => {
  const file = pageImage(c.req.param("id"), Number(c.req.param("pageNo")));
  const info = await stat(file).catch(() => null);
  if (!info) return c.json({ error: "Strona nie jest jeszcze gotowa" }, 404);
  c.header("Content-Type", "image/jpeg");
  c.header("Cache-Control", "private, max-age=86400");
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
});

const dashboardRoot = path.relative(process.cwd(), config.dashboardDir);
app.use("/*", serveStatic({ root: dashboardRoot }));
app.get("/*", serveStatic({ root: dashboardRoot, path: "index.html" }));

