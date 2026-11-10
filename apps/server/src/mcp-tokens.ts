import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { isUuid, requireRole, sessionTokenHash, tenantsOf, type AuthEnv, type Principal } from "./auth.js";
import { sql } from "./db.js";

// Tokens for MCP clients (#166). A connector address carries its token in the URL, where it lands in history and proxy
// logs, so it is not the login session: it only reads (the MCP tools have no writes), works in one firm, has a name the
// person recognises, and can be revoked alone. Only its hash is stored.
const MAX_TOKENS_PER_USER = 20;
const DEFAULT_DAYS = 180;
const MAX_DAYS = 365;

export const isMcpToken = (token: string) => /^bm_[\w-]{40,64}$/.test(token);

// The account behind an MCP token, acting in the token's firm with its role there today: a person blocked in the firm,
// a disabled account or a disabled firm loses access at once.
export const principalFromMcpToken = async (token: string): Promise<Principal | null> => {
  if (!isMcpToken(token)) return null;
  const [row] = await sql<{ id: string; email: string; name: string; role: "operator" | "user"; tenantId: string | null }[]>`
    update mcp_tokens t set last_used_at = now()
    from users u
    where t.token_hash = ${sessionTokenHash(token)} and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
      and u.id = t.user_id and u.disabled_at is null
    returning u.id, u.email, u.name, u.role, t.tenant_id as "tenantId"`;
  if (!row) return null;
  const { tenantId, ...user } = row;
  const tenant = (await tenantsOf(user.id)).find((candidate) => candidate.id === tenantId);
  if (!tenant) return null;
  // MCP is read-only, so the token acts as a worker-level reader of what the person sees in that firm.
  return { role: tenant.role === "worker" ? "app" : "admin", user, operator: false, tenant };
};

export const mcpTokens = new Hono<AuthEnv>();

const tokenColumns = sql`
  id, name, created_at as "createdAt", last_used_at as "lastUsedAt", expires_at as "expiresAt",
  (select name from tenants where id = mcp_tokens.tenant_id) as "tenantName"`;

mcpTokens.get("/api/mcp-tokens", requireRole("admin", "app"), async (c) => {
  const { user } = c.get("principal");
  if (!user) return c.json([]);
  return c.json(await sql`
    select ${tokenColumns} from mcp_tokens
    where user_id = ${user.id} and revoked_at is null and (expires_at is null or expires_at > now()) order by created_at desc`);
});

// The token is shown once; a lost one is revoked and replaced.
mcpTokens.post("/api/mcp-tokens", requireRole("admin", "app"), async (c) => {
  const { user, tenant } = c.get("principal");
  if (!user || !tenant) return c.json({ error: "Token MCP tworzy się z konta w firmie" }, 400);
  const body = await c.req.json<{ name?: unknown; days?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return c.json({ error: "Nazwij token, np. „Claude na laptopie”" }, 400);
  const days = typeof body.days === "number" && body.days >= 1 && body.days <= MAX_DAYS ? Math.floor(body.days) : DEFAULT_DAYS;
  const [active] = await sql<{ count: number }[]>`
    select count(*)::int as count from mcp_tokens where user_id = ${user.id} and revoked_at is null`;
  if ((active?.count ?? 0) >= MAX_TOKENS_PER_USER) return c.json({ error: `Najwyżej ${MAX_TOKENS_PER_USER} tokenów; odwołaj nieużywane` }, 400);
  const token = `bm_${randomBytes(32).toString("base64url")}`;
  const [created] = await sql`
    insert into mcp_tokens (token_hash, user_id, tenant_id, name, expires_at)
    values (${sessionTokenHash(token)}, ${user.id}, ${tenant.id}, ${name}, now() + make_interval(days => ${days}))
    returning ${tokenColumns}`;
  return c.json({ ...created, token }, 201);
});

mcpTokens.delete("/api/mcp-tokens/:id", requireRole("admin", "app"), async (c) => {
  const { user } = c.get("principal");
  const id = c.req.param("id");
  const revoked = user && isUuid(id)
    ? await sql`update mcp_tokens set revoked_at = now() where id = ${id} and user_id = ${user.id} and revoked_at is null returning 1`
    : [];
  return revoked.length ? c.body(null, 204) : c.json({ error: "Nie ma takiego tokenu" }, 404);
});
