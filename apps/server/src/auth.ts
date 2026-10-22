import { hash, verify } from "@node-rs/argon2";
import type { Context, MiddlewareHandler } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { sql } from "./db.js";

// "admin" and "app" are the roles clients already know from the shared tokens. In a firm (#88) an owner or a manager
// acts as admin, a worker as app and only on the projects they are a member of. An operator runs the service and
// sees every firm.
export type Role = "admin" | "app";
export type TenantRole = "owner" | "manager" | "worker";
export type GlobalRole = "operator" | "user";

export type SessionUser = { id: string; email: string; name: string; role: GlobalRole };

export type Tenant = { id: string; name: string; role: TenantRole };

// `user` is null for the shared tokens from env: ADMIN_TOKEN (operator) and the legacy APP_TOKEN.
// `tenant` is the firm the session works in; null for an operator outside any firm or an account without one.
export type Principal = { role: Role; user: SessionUser | null; operator: boolean; tenant: Tenant | null };

export type AuthEnv = { Variables: { principal: Principal } };

export const roleOf = (tenantRole: TenantRole | undefined): Role => (tenantRole === "owner" || tenantRole === "manager" ? "admin" : "app");

const sha256 = (value: string) => createHash("sha256").update(value).digest();

const sameToken = (a: string, b: string) => b !== "" && timingSafeEqual(sha256(a), sha256(b));

export const hashPassword = (password: string) => hash(password);

// Verifying against a throwaway hash when the e-mail is unknown keeps login timing the same either way.
let dummyHash: Promise<string> | undefined;
export const verifyPassword = async (passwordHash: string | undefined, password: string) => {
  if (passwordHash) return verify(passwordHash, password).catch(() => false);
  await verify(await (dummyHash ??= hash(randomBytes(16).toString("hex"))), password).catch(() => false);
  return false;
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const createSession = async (userId: string, tenantId: string | null) => {
  const token = `bs_${randomBytes(32).toString("base64url")}`;
  const [session] = await sql<{ expiresAt: Date }[]>`
    insert into sessions (token_hash, user_id, tenant_id, expires_at)
    values (${sha256(token).toString("hex")}, ${userId}, ${tenantId}, now() + make_interval(days => ${config.sessionTtlDays}))
    returning expires_at as "expiresAt"`;
  return { token, expiresAt: session!.expiresAt };
};

export const revokeSession = (token: string) => sql`delete from sessions where token_hash = ${sha256(token).toString("hex")}`;

export const revokeUserSessions = (userId: string, exceptToken?: string) =>
  sql`delete from sessions where user_id = ${userId} and token_hash <> ${exceptToken ? sha256(exceptToken).toString("hex") : ""}`;

// The firms an account belongs to, oldest membership first. A disabled firm is left out.
export const tenantsOf = (userId: string) => sql<Tenant[]>`
  select t.id, t.name, m.role from tenant_members m join tenants t on t.id = m.tenant_id
  where m.user_id = ${userId} and t.disabled_at is null order by m.created_at, t.created_at`;

// A session in use is extended, so a worker who opens the app regularly never gets logged out.
const sessionOf = async (token: string) => {
  const [row] = await sql<(SessionUser & { tenantId: string | null })[]>`
    update sessions s set last_used_at = now(),
      expires_at = greatest(s.expires_at, now() + make_interval(days => ${config.sessionTtlDays}))
    from users u
    where s.token_hash = ${sha256(token).toString("hex")} and s.expires_at > now()
      and u.id = s.user_id and u.disabled_at is null
    returning u.id, u.email, u.name, u.role, s.tenant_id as "tenantId"`;
  return row ?? null;
};

// The session's firm, or the first one the account still belongs to when that firm is gone or blocked.
const activeTenant = async (userId: string, tenantId: string | null) => {
  const tenants = await tenantsOf(userId);
  return tenants.find((tenant) => tenant.id === tenantId) ?? tenants[0] ?? null;
};

// The legacy APP_TOKEN works in the oldest firm only, until the app logs in with accounts (#91).
const legacyAppTenant = async (): Promise<Tenant | null> => {
  const [tenant] = await sql<{ id: string; name: string }[]>`
    select id, name from tenants where disabled_at is null order by created_at limit 1`;
  return tenant ? { ...tenant, role: "manager" } : null;
};

export const principalFromToken = async (token: string | undefined): Promise<Principal | null> => {
  if (!token) return null;
  if (sameToken(token, config.adminToken)) return { role: "admin", user: null, operator: true, tenant: null };
  if (sameToken(token, config.appToken)) return { role: "app", user: null, operator: false, tenant: await legacyAppTenant() };
  if (!token.startsWith("bs_")) return null;
  const session = await sessionOf(token);
  if (!session) return null;
  const { tenantId, ...user } = session;
  const operator = user.role === "operator";
  const tenant = await activeTenant(user.id, tenantId);
  return { role: operator ? "admin" : roleOf(tenant?.role), user, operator, tenant };
};

export const sessionTokenHash = (token: string) => sha256(token).toString("hex");

export const bearerToken = (header: string | null | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

// An operator sees every project. Anyone else only projects of their firm: owners and managers all of them, a worker
// only those they were added to.
export const canAccessProject = async (principal: Principal, projectId: string) => {
  if (!isUuid(projectId)) return false;
  if (principal.operator) {
    const [project] = await sql`select 1 from projects where id = ${projectId}`;
    return Boolean(project);
  }
  const { tenant, user } = principal;
  if (!tenant) return false;
  if (tenant.role !== "worker") {
    const [project] = await sql`select 1 from projects where id = ${projectId} and tenant_id = ${tenant.id}`;
    return Boolean(project);
  }
  if (!user) return false;
  const [member] = await sql`
    select 1 from project_members where project_id = ${projectId} and user_id = ${user.id} and tenant_id = ${tenant.id}`;
  return Boolean(member);
};

// Projects the principal can see, as a condition on `projects p`.
export const visibleProjects = (principal: Principal) => {
  if (principal.operator) return sql`true`;
  const { tenant, user } = principal;
  if (!tenant) return sql`false`;
  if (tenant.role !== "worker") return sql`p.tenant_id = ${tenant.id}`;
  if (!user) return sql`false`;
  return sql`p.tenant_id = ${tenant.id} and exists (select 1 from project_members m where m.project_id = p.id and m.user_id = ${user.id})`;
};

export const projectOfDocument = async (documentId: string) => {
  if (!isUuid(documentId)) return null;
  const [doc] = await sql<{ projectId: string }[]>`select project_id as "projectId" from documents where id = ${documentId}`;
  return doc?.projectId ?? null;
};

const authorize = (allowed: Role[], token: string | undefined): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const principal = await principalFromToken(token);
  if (!principal || !allowed.includes(principal.role)) return c.json({ error: "Brak dostępu" }, 401);
  c.set("principal", principal);
  await next();
};

export const requireRole = (...allowed: Role[]): MiddlewareHandler<AuthEnv> => (c, next) =>
  authorize(allowed, bearerToken(c.req.header("authorization")))(c, next);

// <img src> cannot send headers, so page images also accept the token in ?token=. Nothing else does,
// because query strings end up in logs and browser history.
export const requireRoleOrQueryToken = (...allowed: Role[]): MiddlewareHandler<AuthEnv> => (c, next) =>
  authorize(allowed, bearerToken(c.req.header("authorization")) ?? c.req.query("token"))(c, next);

const notFound = (c: Context, what: "projektu" | "dokumentu") => c.json({ error: `Nie ma takiego ${what}` }, 404);

// Run after requireRole. A project the caller cannot see answers 404, the same as one that does not exist.
export const requireProjectAccess = (param = "id"): MiddlewareHandler<AuthEnv> => async (c, next) => {
  if (!(await canAccessProject(c.get("principal"), c.req.param(param) ?? ""))) return notFound(c, "projektu");
  await next();
};

export const requireDocumentAccess = (param = "id"): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const projectId = await projectOfDocument(c.req.param(param) ?? "");
  if (!projectId || !(await canAccessProject(c.get("principal"), projectId))) return notFound(c, "dokumentu");
  await next();
};

// The CopilotKit runtime builds the agent from the raw request, so the agent factory checks access on its own
// instead of trusting that a middleware ran before it.
export const agentProject = async (request: Request, allowed: Role[]) => {
  const principal = await principalFromToken(bearerToken(request.headers.get("authorization")));
  if (!principal || !allowed.includes(principal.role)) throw new Error("Brak dostępu");
  const projectId = request.headers.get("x-project-id");
  if (!projectId) throw new Error("Brak nagłówka x-project-id");
  if (!(await canAccessProject(principal, projectId))) throw new Error("Nieznany projekt");
  const [project] = await sql<{ tenantId: string }[]>`select tenant_id as "tenantId" from projects where id = ${projectId}`;
  return { projectId, tenantId: project!.tenantId };
};

export const agentProjectId = async (request: Request, allowed: Role[]) => (await agentProject(request, allowed)).projectId;

// Managing people in a firm is for its owners (and the operator); managers run projects only.
export const requireTenantOwner: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const { operator, tenant } = c.get("principal");
  if (!operator && tenant?.role !== "owner") return c.json({ error: "Tylko właściciel firmy zarządza ludźmi" }, 403);
  await next();
};
