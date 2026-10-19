import { hash, verify } from "@node-rs/argon2";
import type { Context, MiddlewareHandler } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { sql } from "./db.js";

// "admin" and "app" are the roles clients already know from the shared tokens. An owner account acts as
// admin, a contractor account as app, but limited to the projects it is a member of.
export type Role = "admin" | "app";
export type UserRole = "owner" | "contractor";

export type SessionUser = { id: string; email: string; name: string; role: UserRole };

// `user` is null for the shared tokens from env: ADMIN_TOKEN (emergency admin) and the legacy APP_TOKEN.
export type Principal = { role: Role; user: SessionUser | null };

export type AuthEnv = { Variables: { principal: Principal } };

const roleOf = (userRole: UserRole): Role => (userRole === "owner" ? "admin" : "app");

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

export const createSession = async (userId: string) => {
  const token = `bs_${randomBytes(32).toString("base64url")}`;
  const [session] = await sql<{ expiresAt: Date }[]>`
    insert into sessions (token_hash, user_id, expires_at)
    values (${sha256(token).toString("hex")}, ${userId}, now() + make_interval(days => ${config.sessionTtlDays}))
    returning expires_at as "expiresAt"`;
  return { token, expiresAt: session!.expiresAt };
};

export const revokeSession = (token: string) => sql`delete from sessions where token_hash = ${sha256(token).toString("hex")}`;

export const revokeUserSessions = (userId: string, exceptToken?: string) =>
  sql`delete from sessions where user_id = ${userId} and token_hash <> ${exceptToken ? sha256(exceptToken).toString("hex") : ""}`;

// A session in use is extended, so a contractor who opens the app regularly never gets logged out.
const sessionUser = async (token: string) => {
  const [user] = await sql<SessionUser[]>`
    update sessions s set last_used_at = now(),
      expires_at = greatest(s.expires_at, now() + make_interval(days => ${config.sessionTtlDays}))
    from users u
    where s.token_hash = ${sha256(token).toString("hex")} and s.expires_at > now()
      and u.id = s.user_id and u.disabled_at is null
    returning u.id, u.email, u.name, u.role`;
  return user ?? null;
};

export const principalFromToken = async (token: string | undefined): Promise<Principal | null> => {
  if (!token) return null;
  if (sameToken(token, config.adminToken)) return { role: "admin", user: null };
  if (sameToken(token, config.appToken)) return { role: "app", user: null };
  if (!token.startsWith("bs_")) return null;
  const user = await sessionUser(token);
  return user ? { role: roleOf(user.role), user } : null;
};

export const bearerToken = (header: string | null | undefined) => header?.match(/^Bearer\s+(.+)$/i)?.[1];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

// Owners and the shared tokens see every project; a contractor only the projects they were added to.
export const canAccessProject = async (principal: Principal, projectId: string) => {
  if (!isUuid(projectId)) return false;
  if (principal.role === "admin" || !principal.user) {
    const [project] = await sql`select 1 from projects where id = ${projectId}`;
    return Boolean(project);
  }
  const [member] = await sql`select 1 from project_members where project_id = ${projectId} and user_id = ${principal.user.id}`;
  return Boolean(member);
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
export const agentProjectId = async (request: Request, allowed: Role[]) => {
  const principal = await principalFromToken(bearerToken(request.headers.get("authorization")));
  if (!principal || !allowed.includes(principal.role)) throw new Error("Brak dostępu");
  const projectId = request.headers.get("x-project-id");
  if (!projectId) throw new Error("Brak nagłówka x-project-id");
  if (!(await canAccessProject(principal, projectId))) throw new Error("Nieznany projekt");
  return projectId;
};
