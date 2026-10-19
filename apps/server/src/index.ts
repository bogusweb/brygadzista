import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { CopilotRuntime, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createProjectAgent } from "./agent.js";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { startIngestWorker } from "./ingest.js";
import { documentDir, documentPdf, pageImage } from "./storage.js";

type Role = "admin" | "app";

const roleForToken = (token: string | undefined): Role | null => {
  if (token === config.adminToken) return "admin";
  if (token === config.appToken) return "app";
  return null;
};

const requestToken = (header: string | undefined, query: string | undefined) =>
  header?.replace(/^Bearer\s+/i, "") ?? query;

const requireRole = (...allowed: Role[]): MiddlewareHandler => async (c, next) => {
  const role = roleForToken(requestToken(c.req.header("authorization"), c.req.query("token")));
  if (!role || !allowed.includes(role)) return c.json({ error: "Brak dostępu" }, 401);
  await next();
};

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

const app = new Hono();
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

app.get("/api/projects/:id/documents", requireRole("app", "admin"), async (c) =>
  c.json(await sql`
    select id, filename, page_count as "pageCount", indexed_pages as "indexedPages", status, error, created_at as "createdAt"
    from documents where project_id = ${c.req.param("id")} order by created_at`),
);

// The PDF is streamed straight to disk so large projects never sit in memory.
app.put("/api/projects/:id/documents", requireRole("admin"), async (c) => {
  const filename = c.req.query("filename") ?? "projekt.pdf";
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Brak pliku" }, 400);
  const [doc] = await sql<{ id: string }[]>`
    insert into documents (project_id, filename, status) values (${c.req.param("id")}, ${filename}, 'uploading') returning id`;
  await mkdir(documentDir(doc!.id), { recursive: true });
  await pipeline(Readable.fromWeb(body as WebReadableStream), createWriteStream(documentPdf(doc!.id)));
  const handle = await open(documentPdf(doc!.id));
  const { buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
  await handle.close();
  const header = buffer.toString();
  if (header !== "%PDF-") {
    await sql`delete from documents where id = ${doc!.id}`;
    await rm(documentDir(doc!.id), { recursive: true, force: true });
    return c.json({ error: "To nie jest plik PDF" }, 400);
  }
  await sql`update documents set status = 'queued' where id = ${doc!.id}`;
  return c.json({ id: doc!.id }, 201);
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

app.get("/api/documents/:id/pages/:pageNo/image", requireRole("app", "admin"), async (c) => {
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

await migrate();
await startIngestWorker();
serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, ({ port }) => console.log(`brygadzista: listening on ${port}`));
