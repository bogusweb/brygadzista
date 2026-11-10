import { hash, verify } from "@node-rs/argon2";
import type { Context, MiddlewareHandler } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { clientIp } from "./client-ip.js";
import { config } from "./config.js";
import { sql, withTenant } from "./db.js";

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

// argon2 is meant to be slow and memory-hungry, so a flood of logins must not run hundreds of them at once on a
// two-core server (#170): extra ones wait their turn.
const passwordSlots = (() => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= config.passwordHashConcurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
})();

// Longer than any real password; refused before hashing.
export const MAX_PASSWORD_LENGTH = 256;

export const hashPassword = (password: string) => passwordSlots(() => hash(password));

// Verifying against a throwaway hash when the e-mail is unknown keeps login timing the same either way.
let dummyHash: Promise<string> | undefined;
export const verifyPassword = async (passwordHash: string | undefined, password: string) => {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  if (passwordHash) return passwordSlots(() => verify(passwordHash, password).catch(() => false));
  const dummy = await (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));
  await passwordSlots(() => verify(dummy, password).catch(() => false));
  return false;
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const createSession = async (userId: string, tenantId: string | null, request?: Request) => {
  const token = `bs_${randomBytes(32).toString("base64url")}`;
  const userAgent = (request?.headers.get("user-agent") ?? "").slice(0, 300);
  const ip = request ? clientIp(request) : "";
  const [session] = await sql<{ expiresAt: Date }[]>`
    insert into sessions (token_hash, user_id, tenant_id, expires_at, user_agent, ip)
    values (${sha256(token).toString("hex")}, ${userId}, ${tenantId}, now() + make_interval(days => ${config.sessionTtlDays}),
      ${userAgent}, ${ip})
    returning expires_at as "expiresAt"`;
  return { token, expiresAt: session!.expiresAt };
};

export const revokeSession = (token: string) => sql`delete from sessions where token_hash = ${sha256(token).toString("hex")}`;

export const revokeUserSessions = (userId: string, exceptToken?: string) =>
  sql`delete from sessions where user_id = ${userId} and token_hash <> ${exceptToken ? sha256(exceptToken).toString("hex") : ""}`;

// The firms an account belongs to, oldest membership first. A disabled firm, or one that blocked the person, is left out.
export const tenantsOf = (userId: string) => sql<Tenant[]>`
  select t.id, t.name, m.role from tenant_members m join tenants t on t.id = m.tenant_id
  where m.user_id = ${userId} and t.disabled_at is null and m.blocked_at is null order by m.created_at, t.created_at`;

// A session in use is extended, so a worker who opens the app regularly stays logged in, but never past the maximum
// lifetime from login (#167): a stolen token stops working on its own.
const sessionMaxAge = sql`make_interval(days => case when u.role = 'operator' then ${config.operatorSessionMaxDays}::int else ${config.sessionMaxDays}::int end)`;
const sessionOf = async (tokenHash: string) => {
  const [row] = await sql<(SessionUser & { tenantId: string | null })[]>`
    update sessions s set last_used_at = now(),
      expires_at = least(greatest(s.expires_at, now() + make_interval(days => ${config.sessionTtlDays})), s.created_at + ${sessionMaxAge})
    from users u
    where s.token_hash = ${tokenHash} and s.expires_at > now() and s.created_at + ${sessionMaxAge} > now()
      and u.id = s.user_id and u.disabled_at is null
    returning u.id, u.email, u.name, u.role, s.tenant_id as "tenantId"`;
  return row ?? null;
};

// The session's firm, or the first one the account still belongs to when that firm is gone or blocked.
const activeTenant = async (userId: string, tenantId: string | null) => {
  const tenants = await tenantsOf(userId);
  return tenants.find((tenant) => tenant.id === tenantId) ?? tenants[0] ?? null;
};

const enteredTenant = async (tenantId: string | null): Promise<Tenant | null> => {
  if (!tenantId) return null;
  const [tenant] = await sql<{ id: string; name: string }[]>`select id, name from tenants where id = ${tenantId}`;
  return tenant ? { ...tenant, role: "owner" } : null;
};

// The legacy APP_TOKEN works in the oldest firm only, and only outside production (#91).
const legacyAppTenant = async (): Promise<Tenant | null> => {
  const [tenant] = await sql<{ id: string; name: string }[]>`
    select id, name from tenants where disabled_at is null order by created_at limit 1`;
  return tenant ? { ...tenant, role: "manager" } : null;
};

// ADMIN_TOKEN (#168): empty turns it off (production should log in with the operator's account), and
// ADMIN_TOKEN_IPS limits where it works from.
const adminTokenAllowed = (request: Request | undefined) =>
  !config.adminTokenIps.length || (request !== undefined && config.adminTokenIps.includes(clientIp(request)));

export const principalFromToken = async (token: string | undefined, request?: Request): Promise<Principal | null> => {
  if (!token) return null;
  if (config.adminToken && sameToken(token, config.adminToken)) {
    return adminTokenAllowed(request) ? { role: "admin", user: null, operator: true, tenant: null } : null;
  }
  if (sameToken(token, config.appToken)) return { role: "app", user: null, operator: false, tenant: await legacyAppTenant() };
  if (!token.startsWith("bs_")) return null;
  return principalFromSessionHash(sha256(token).toString("hex"));
};

// The principal of a live session, by its token's hash; file links carry the hash, never the token (#165).
export const principalFromSessionHash = async (tokenHash: string): Promise<Principal | null> => {
  const session = await sessionOf(tokenHash);
  if (!session) return null;
  const { tenantId, ...user } = session;
  const operator = user.role === "operator";
  // An operator works inside a firm only after entering it (#94), and then acts as its owner.
  const tenant = operator ? await enteredTenant(tenantId) : await activeTenant(user.id, tenantId);
  return { role: operator ? "admin" : roleOf(tenant?.role), user, operator, tenant };
};

export const sessionTokenHash = (token: string) => sha256(token).toString("hex");

export const bearerToken = (header: string | null | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

// An operator sees every project. Anyone else only projects of their firm: owners and managers all of them, a worker
// only those they were added to. Returns the project's firm, or null when the caller cannot see it.
export const canAccessProject = async (principal: Principal, projectId: string): Promise<string | null> => {
  if (!isUuid(projectId)) return null;
  const [project] = await sql<{ tenantId: string }[]>`select tenant_id as "tenantId" from projects where id = ${projectId}`;
  if (!project) return null;
  if (principal.operator) {
    if (principal.tenant?.id !== project.tenantId) await auditOperatorRead(principal, project.tenantId);
    return project.tenantId;
  }
  const { tenant, user } = principal;
  if (!tenant || tenant.id !== project.tenantId) return null;
  if (tenant.role !== "worker") return project.tenantId;
  if (!user) return null;
  const [member] = await sql`select 1 from project_members where project_id = ${projectId} and user_id = ${user.id}`;
  return member ? project.tenantId : null;
};

// An operator can read any firm's project without entering the firm. Each such read is written down (#168), once an
// hour per operator and firm, so the audit shows who looked at which firm's data without flooding it.
const OPERATOR_READ_AUDIT_MS = 60 * 60_000;
const operatorReads = new Map<string, number>();
const auditOperatorRead = async (principal: Principal, tenantId: string) => {
  const who = principal.user?.id ?? "ADMIN_TOKEN";
  const key = `${who}:${tenantId}`;
  const now = Date.now();
  if ((operatorReads.get(key) ?? 0) > now - OPERATOR_READ_AUDIT_MS) return;
  if (operatorReads.size > 10_000) operatorReads.clear();
  operatorReads.set(key, now);
  await sql`
    insert into operator_audit (tenant_id, tenant_name, action, operator_id, operator_name)
    select id, name, 'read', ${principal.user?.id ?? null}, ${principal.user?.email ?? "ADMIN_TOKEN"} from tenants where id = ${tenantId}`;
};

// Only for tests.
export const forgetOperatorReads = () => operatorReads.clear();

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

export const authorize = (allowed: Role[], token: string | undefined): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const principal = await principalFromToken(token, c.req.raw);
  if (!principal || !allowed.includes(principal.role)) return c.json({ error: "Brak dostępu" }, 401);
  c.set("principal", principal);
  await next();
};

export const requireRole = (...allowed: Role[]): MiddlewareHandler<AuthEnv> => (c, next) =>
  authorize(allowed, bearerToken(c.req.header("authorization")))(c, next);


const notFound = (c: Context, what: "projektu" | "dokumentu") => c.json({ error: `Nie ma takiego ${what}` }, 404);

// Run after requireRole. A project the caller cannot see answers 404, the same as one that does not exist.
// The rest of the request runs limited to the project's firm (#92), also in the database.
export const requireProjectAccess = (param = "id"): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const tenantId = await canAccessProject(c.get("principal"), c.req.param(param) ?? "");
  if (!tenantId) return notFound(c, "projektu");
  await withTenant(tenantId, next);
};

export const requireDocumentAccess = (param = "id"): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const projectId = await projectOfDocument(c.req.param(param) ?? "");
  const tenantId = projectId ? await canAccessProject(c.get("principal"), projectId) : null;
  if (!tenantId) return notFound(c, "dokumentu");
  await withTenant(tenantId, next);
};

// The CopilotKit runtime builds the agent from the raw request, so the agent factory checks access on its own
// instead of trusting that a middleware ran before it.
export const agentProject = async (request: Request, allowed: Role[]) => {
  const principal = await principalFromToken(bearerToken(request.headers.get("authorization")), request);
  if (!principal || !allowed.includes(principal.role)) throw new Error("Brak dostępu");
  const projectId = request.headers.get("x-project-id");
  if (!projectId) throw new Error("Brak nagłówka x-project-id");
  const tenantId = await canAccessProject(principal, projectId);
  if (!tenantId) throw new Error("Nieznany projekt");
  return { projectId, tenantId, principal };
};

export const agentProjectId = async (request: Request, allowed: Role[]) => (await agentProject(request, allowed)).projectId;

// Managing people in a firm is for its owners (and the operator); managers run projects only.
export const requireTenantOwner: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const { operator, tenant } = c.get("principal");
  if (!operator && tenant?.role !== "owner") return c.json({ error: "Tylko właściciel firmy zarządza ludźmi" }, 403);
  await next();
};
