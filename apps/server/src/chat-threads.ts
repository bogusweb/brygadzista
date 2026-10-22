import type { MiddlewareHandler } from "hono";
import { canAccessProject, type AuthEnv } from "./auth.js";
import { sql } from "./db.js";
import { recordUsage } from "./operator.js";
import { limiters, principalKey, tooManyRequests } from "./rate-limit.js";

// Chat threads (#92): the runtime keeps them in memory by thread id alone, so the first run of a thread claims it for
// the caller, the project and its firm, and nobody else can run, connect to or stop it. Thread listing and clearing
// would cross all of them, so they are not offered.
const AGENT_ROUTE = /\/agent\/[^/]+\/(run|connect|suggest|stop)(?:\/([^/]+))?$/;

const threadIdOf = async (request: Request, action: string, pathThreadId: string | undefined) => {
  if (action === "stop") return pathThreadId ? decodeURIComponent(pathThreadId) : null;
  const body = await request.clone().json().catch(() => null) as { threadId?: unknown } | null;
  return typeof body?.threadId === "string" && body.threadId ? body.threadId : null;
};

const claimThread = async (threadId: string, projectId: string, tenantId: string, owner: string, userId: string | null) => {
  await sql`
    insert into chat_threads (id, project_id, tenant_id, owner, user_id) values (${threadId}, ${projectId}, ${tenantId}, ${owner}, ${userId})
    on conflict (id) do nothing`;
  const [thread] = await sql<{ projectId: string; owner: string }[]>`
    select project_id as "projectId", owner from chat_threads where id = ${threadId}`;
  return thread?.projectId === projectId && thread.owner === owner;
};

export const chatThreads: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const { pathname } = new URL(c.req.url);
  if (pathname.endsWith("/info")) return next();
  const route = pathname.match(AGENT_ROUTE);
  if (!route) return c.json({ error: "Nie ma takiej trasy" }, 404);

  const principal = c.get("principal");
  const projectId = c.req.header("x-project-id") ?? "";
  // A project the caller cannot see is refused by the agent factory itself.
  const tenantId = await canAccessProject(principal, projectId);
  const threadId = tenantId ? await threadIdOf(c.req.raw, route[1]!, route[2]) : null;
  if (tenantId && threadId && !(await claimThread(threadId, projectId, tenantId, principalKey(principal), principal.user?.id ?? null))) {
    return c.json({ error: "Nie ma takiej rozmowy", message: "Nie ma takiej rozmowy" }, 404);
  }
  // Agent runs count per firm too (#94): a shared limit and the usage the operator sees.
  if (tenantId && (route[1] === "run" || route[1] === "suggest")) {
    const retryAfter = limiters.chatTenant.hit(tenantId);
    if (retryAfter !== null) return tooManyRequests(retryAfter);
    await recordUsage(tenantId, "chat_runs");
  }
  await next();
};
