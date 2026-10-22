import { serveStatic } from "@hono/node-server/serve-static";
import { CopilotRuntime, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { buildingPrompt, createProjectAgent } from "./agent.js";
import { BUILDING_TYPES, DEFAULT_BUILDING_TYPE, buildingType, isBuildingType } from "./building-types.js";
import { A2UI_CATALOG_ID } from "./a2ui-catalog.js";
import { a2uiCatalogSchema } from "./a2ui-schema.js";
import {
  agentProject,
  isUuid,
  requireDocumentAccess,
  requireProjectAccess,
  requireRole,
  requireRoleOrQueryToken,
  visibleProjects,
  type AuthEnv,
  type Role,
} from "./auth.js";
import { cards } from "./cards.js";
import { chatThreads } from "./chat-threads.js";
import { schedules } from "./schedules.js";
import { checklists } from "./checklists.js";
import { citationCheck } from "./citations.js";
import { config } from "./config.js";
import { embeddingStatus } from "./embedding-sets.js";
import { defaultTenantId, sql } from "./db.js";
import { estimateIndexing, etaSeconds } from "./estimate.js";
import { defects } from "./defects.js";
import { diary } from "./diary.js";
import { protocols } from "./protocols.js";
import { reports } from "./reports.js";
import { site } from "./site.js";
import { FakeProjectAgent } from "./fake-agent.js";
import { pdfPageCount } from "./pdf.js";
import { projectOutline } from "./project-outline.js";
import { designerAnswersPrompt, questions } from "./questions.js";
import { mcp } from "./mcp.js";
import { pins, removeDocumentPhotos, removeProjectFiles } from "./pins.js";
import { limiters, rateLimit } from "./rate-limit.js";
import { documentDir, documentPdf, pageImage } from "./storage.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

// Chat is limited per user on agent runs only; the runtime's info and connect calls are free.
const isAgentRun = (request: Request) => request.method === "POST" && /\/agent\/[^/]+\/(run|suggest)$/.test(new URL(request.url).pathname);

const projectAgents =
  (roles: Role[]) =>
  async ({ request }: { request: Request }) => {
    const { projectId, tenantId } = await agentProject(request, roles);
    const [project] = await sql<{ buildingType: string }[]>`select building_type as "buildingType" from projects where id = ${projectId}`;
    const agent = config.fakeAgent
      ? new FakeProjectAgent(projectId)
      : createProjectAgent(projectId, tenantId, buildingPrompt(buildingType(project?.buildingType)) + (await designerAnswersPrompt(projectId)));
    return { default: agent.use(citationCheck) };
  };

// Both clients render A2UI surfaces built from the construction catalog (src/a2ui-catalog.ts):
// the dashboard with CopilotKit's web renderer, the mobile app with its own native one.
const a2ui = { injectA2UITool: true, schema: a2uiCatalogSchema, defaultCatalogId: A2UI_CATALOG_ID };
const appRuntime = new CopilotRuntime({ agents: projectAgents(["app", "admin"]), a2ui });
const adminRuntime = new CopilotRuntime({ agents: projectAgents(["admin"]), a2ui });

export const app = new Hono<AuthEnv>();
app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-project-id"] }));

// `llm` tells an operator at a glance whether the OpenRouter key reached the server.
app.get("/api/health", (c) => c.json({ ok: true, llm: Boolean(config.openrouterApiKey) }));

// The embedding model search uses, and the progress of a change to a new one (#46).
app.get("/api/admin/embeddings", requireRole("admin"), async (c) => c.json(await embeddingStatus()));
app.route("/", users);
app.route("/", tenants);
app.route("/", pins);
app.route("/", defects);
app.route("/", diary);
app.route("/", site);
app.route("/", reports);
app.route("/", protocols);
app.route("/", checklists);
app.route("/", questions);
app.route("/", cards);
app.route("/", schedules);
app.route("/", mcp);

app.use("/api/copilotkit/*", requireRole("app", "admin"), rateLimit(limiters.chat, isAgentRun), chatThreads);
app.route("/", createCopilotEndpoint({ runtime: appRuntime, basePath: "/api/copilotkit" }));
app.use("/api/admin/copilotkit/*", requireRole("admin"), rateLimit(limiters.chat, isAgentRun), chatThreads);
app.route("/", createCopilotEndpoint({ runtime: adminRuntime, basePath: "/api/admin/copilotkit" }));

// Projects of the session's firm; a worker sees only the ones they are a member of, an operator every firm's.
app.get("/api/projects", requireRole("app", "admin"), async (c) =>
  c.json(await sql`
    select p.id, p.name, p.tenant_id as "tenantId", p.building_type as "buildingType", p.created_at as "createdAt",
      (select count(*)::int from documents d where d.project_id = p.id) as "documentCount"
    from projects p where ${visibleProjects(c.get("principal"))} order by p.created_at desc`),
);

// A new project belongs to the session's firm. An operator outside a firm names one, or it goes to the oldest.
app.post("/api/projects", requireRole("admin"), async (c) => {
  const { name, tenantId, buildingType: type } = await c.req.json<{ name?: string; tenantId?: unknown; buildingType?: unknown }>();
  if (!name?.trim()) return c.json({ error: "Podaj nazwę projektu" }, 400);
  if (type !== undefined && !isBuildingType(type)) return c.json({ error: "Nieznany typ budowy" }, 400);
  const principal = c.get("principal");
  const requested = principal.operator && typeof tenantId === "string" && isUuid(tenantId) ? tenantId : null;
  const tenant = principal.tenant?.id ?? requested ?? (principal.operator ? await defaultTenantId() : null);
  if (!tenant) return c.json({ error: "Brak firmy" }, 403);
  const [project] = await sql`
    insert into projects (name, tenant_id, building_type) select ${name.trim()}, id, ${type ?? DEFAULT_BUILDING_TYPE} from tenants
    where id = ${tenant} returning id, name, building_type as "buildingType"`;
  return project ? c.json(project, 201) : c.json({ error: "Nie ma takiej firmy" }, 404);
});

app.get("/api/building-types", requireRole("app", "admin"), (c) =>
  c.json(BUILDING_TYPES.map(({ type, label, stages }) => ({ type, label, stages }))),
);

// Changing the type later keeps everything made so far; it only changes which stages come first and the agent's context.
app.patch("/api/projects/:id", requireRole("admin"), requireProjectAccess(), async (c) => {
  const body = await c.req.json<{ name?: unknown; buildingType?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (body.buildingType !== undefined && !isBuildingType(body.buildingType)) return c.json({ error: "Nieznany typ budowy" }, 400);
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) return c.json({ error: "Podaj nazwę projektu" }, 400);
  const name = typeof body.name === "string" ? body.name.trim() : null;
  const type = isBuildingType(body.buildingType) ? body.buildingType : null;
  const [project] = await sql`
    update projects set name = coalesce(${name}, name), building_type = coalesce(${type}, building_type)
    where id = ${c.req.param("id")} returning id, name, building_type as "buildingType"`;
  return c.json(project);
});

app.delete("/api/projects/:id", requireRole("admin"), requireProjectAccess(), async (c) => {
  const documents = await sql<{ id: string }[]>`select id from documents where project_id = ${c.req.param("id")}`;
  const notes = await sql<{ audioFile: string }[]>`
    select audio_file as "audioFile" from diary_entries where project_id = ${c.req.param("id")} and audio_file is not null`;
  await sql`delete from projects where id = ${c.req.param("id")}`;
  await Promise.all(documents.map((doc) => rm(documentDir(doc.id), { recursive: true, force: true })));
  await Promise.all(notes.map((note) => rm(note.audioFile, { force: true })));
  await removeProjectFiles(c.req.param("id"));
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

app.get("/api/projects/:id/documents", requireRole("app", "admin"), requireProjectAccess(), async (c) =>
  c.json((await documentRows(sql`d.project_id = ${c.req.param("id")}`)).map(withProgress)),
);

app.get("/api/documents/:id", requireRole("app", "admin"), requireDocumentAccess(), async (c) => {
  const [doc] = await documentRows(sql`d.id = ${c.req.param("id")}`);
  return doc ? c.json(withProgress(doc)) : c.json({ error: "Nie ma takiego dokumentu" }, 404);
});

// Table of contents of the document (#44): parts of the project with their pages, also what the agent browses by.
app.get("/api/documents/:id/outline", requireRole("app", "admin"), requireDocumentAccess(), async (c) => {
  const [doc] = await sql<{ projectId: string }[]>`select project_id as "projectId" from documents where id = ${c.req.param("id")}`;
  if (!doc) return c.json({ error: "Nie ma takiego dokumentu" }, 404);
  const found = (await projectOutline(doc.projectId)).find((document) => document.documentId === c.req.param("id"));
  return c.json(found);
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
app.put("/api/projects/:id/documents", requireRole("admin"), requireProjectAccess(), rateLimit(limiters.upload), async (c) => {
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

app.post("/api/documents/:id/start", requireRole("admin"), requireDocumentAccess(), async (c) => {
  const [doc] = await sql`
    update documents set status = 'queued' where id = ${c.req.param("id")} and status = 'awaiting_start' returning id`;
  return doc ? c.json({ ok: true }) : c.json({ error: "Dokument nie czeka na start" }, 409);
});

app.post("/api/documents/:id/reindex", requireRole("admin"), requireDocumentAccess(), async (c) => {
  await sql`update pages set indexed = false where document_id = ${c.req.param("id")}`;
  await sql`update documents set status = 'queued', error = null where id = ${c.req.param("id")}`;
  return c.json({ ok: true });
});

// Unlike reindex, resume keeps finished pages and only takes those not done yet (missing, failed, or interrupted
// by a pause), so nothing already paid for is embedded again.
app.post("/api/documents/:id/resume", requireRole("admin"), requireDocumentAccess(), async (c) => {
  const [doc] = await sql`
    update documents set status = 'queued', error = null
    where id = ${c.req.param("id")} and status in ('paused', 'error', 'ready') returning id`;
  return doc ? c.json({ ok: true }) : c.json({ error: "Tego dokumentu nie da się teraz wznowić" }, 409);
});

app.delete("/api/documents/:id", requireRole("admin"), requireDocumentAccess(), async (c) => {
  await removeDocumentPhotos(c.req.param("id"));
  await sql`delete from documents where id = ${c.req.param("id")}`;
  await rm(documentDir(c.req.param("id")), { recursive: true, force: true });
  return c.body(null, 204);
});

app.get("/api/documents/:id/pages", requireRole("app", "admin"), requireDocumentAccess(), async (c) =>
  c.json(await sql`
    select page_no as "pageNo", title, kind, summary, facts, indexed
    from pages where document_id = ${c.req.param("id")} order by page_no`),
);

// Everything the app needs to search a project on site without signal (#51): the text of every indexed page.
// A page that failed indexing still has its PDF text, so it is included too.
app.get("/api/projects/:id/search-index", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const pages = await sql`
    select p.document_id as "documentId", d.filename, p.page_no as "pageNo", p.title, p.kind, p.summary,
      p.keywords, p.raw_text as text
    from pages p join documents d on d.id = p.document_id
    where p.project_id = ${c.req.param("id")} and (p.indexed or p.raw_text <> '')
    order by d.created_at, p.page_no`;
  return c.json({ generatedAt: new Date().toISOString(), pages });
});

// Full PDF text of one page, loaded only when a page is opened (the page list stays small for huge documents).
app.get("/api/documents/:id/pages/:pageNo/text", requireRole("app", "admin"), requireDocumentAccess(), async (c) => {
  const pageNo = Number(c.req.param("pageNo"));
  if (!Number.isInteger(pageNo)) return c.json({ error: "Nie ma takiej strony" }, 404);
  const [page] = await sql<{ text: string }[]>`
    select raw_text as text from pages where document_id = ${c.req.param("id")} and page_no = ${pageNo}`;
  if (!page) return c.json({ error: "Nie ma takiej strony" }, 404);
  return c.json(page);
});

app.get("/api/documents/:id/pages/:pageNo/image", requireRoleOrQueryToken("app", "admin"), requireDocumentAccess(), async (c) => {
  const file = pageImage(c.req.param("id"), Number(c.req.param("pageNo")));
  const info = await stat(file).catch(() => null);
  if (!info) return c.json({ error: "Strona nie jest jeszcze gotowa" }, 404);
  c.header("Content-Type", "image/jpeg");
  c.header("Cache-Control", "private, max-age=86400");
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
});

// The contractor app in the browser: /app/* from the Expo web export, unknown paths fall back to its index.html.
const mobileWebRoot = path.relative(process.cwd(), config.mobileWebDir);
const stripAppPrefix = (requestPath: string) => requestPath.replace(/^\/app/, "") || "/";
app.get("/app", (c) => c.redirect("/app/"));
app.use("/app/*", serveStatic({ root: mobileWebRoot, rewriteRequestPath: stripAppPrefix }));
app.get("/app/*", serveStatic({ root: mobileWebRoot, path: "index.html" }));

const dashboardRoot = path.relative(process.cwd(), config.dashboardDir);
app.use("/*", serveStatic({ root: dashboardRoot }));
app.get("/*", serveStatic({ root: dashboardRoot, path: "index.html" }));

