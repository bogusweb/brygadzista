import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import {
  bearerToken,
  createSession,
  hashPassword,
  isUuid,
  normalizeEmail,
  requireProjectAccess,
  requireRole,
  requireTenantOwner,
  revokeSession,
  revokeUserSessions,
  roleOf,
  sessionTokenHash,
  tenantsOf,
  verifyPassword,
  type AuthEnv,
  type Principal,
  type TenantRole,
} from "./auth.js";
import { defaultTenantId, sql } from "./db.js";
import { limiters, tooManyRequests } from "./rate-limit.js";

const MIN_PASSWORD_LENGTH = 10;
const TENANT_ROLES: TenantRole[] = ["owner", "manager", "worker"];
export const ROLE_ERROR = "Rola to owner, manager albo worker";

export const passwordProblem = (password: unknown) =>
  typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH
    ? `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków`
    : null;

// "contractor" is the role from before firms; it means a worker.
export const tenantRole = (role: unknown): TenantRole | null =>
  role === "contractor" ? "worker" : TENANT_ROLES.includes(role as TenantRole) ? (role as TenantRole) : null;

// Behind Openship's proxy the client address is the first entry of X-Forwarded-For.
export const clientIp = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

const userColumns = sql`u.id, u.email, u.name, u.disabled_at is not null as disabled, u.created_at as "createdAt"`;

// The firm whose people a request manages: the session's firm, or for an operator outside a firm the one in ?tenantId=.
export const scopeTenant = (principal: Principal, requested: string | undefined) =>
  principal.tenant?.id ?? (principal.operator && requested && isUuid(requested) ? requested : null);

const memberRow = (tenantId: string, userId: string) => sql`
  select ${userColumns}, m.role, m.blocked_at is not null as blocked,
    coalesce((select array_agg(pm.project_id order by pm.created_at) from project_members pm
      where pm.user_id = u.id and pm.tenant_id = m.tenant_id), '{}') as "projectIds"
  from tenant_members m join users u on u.id = m.user_id
  where m.tenant_id = ${tenantId} and m.user_id = ${userId}`;

const me = async (principal: Principal) => ({
  role: principal.role,
  user: principal.user,
  operator: principal.operator,
  tenant: principal.tenant,
  tenants: principal.user ? await tenantsOf(principal.user.id) : [],
});

export const users = new Hono<AuthEnv>();

users.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ email?: unknown; password?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.email !== "string" || typeof body.password !== "string") return c.json({ error: "Podaj e-mail i hasło" }, 400);
  const email = normalizeEmail(body.email);
  const retryAfter = limiters.loginIp.hit(clientIp(c.req.raw)) ?? limiters.loginEmail.hit(email);
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const [user] = await sql<{ id: string; email: string; name: string; role: "operator" | "user"; passwordHash: string; disabled: boolean }[]>`
    select id, email, name, role, password_hash as "passwordHash", disabled_at is not null as disabled
    from users where email = ${email}`;
  if (!(await verifyPassword(user?.passwordHash, body.password)) || !user || user.disabled) {
    return c.json({ error: "Nieprawidłowy e-mail lub hasło" }, 401);
  }
  limiters.loginEmail.forget(email);
  const tenants = await tenantsOf(user.id);
  const tenant = tenants[0] ?? null;
  if (!tenant && user.role !== "operator") return c.json({ error: "Konto nie należy do żadnej aktywnej firmy" }, 403);
  const session = await createSession(user.id, tenant?.id ?? null);
  return c.json({
    token: session.token,
    expiresAt: session.expiresAt,
    role: user.role === "operator" ? "admin" : roleOf(tenant?.role),
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    operator: user.role === "operator",
    tenant,
    tenants,
  });
});

// Lets a client check a token (and which role and firm it carries) before storing it. `user` is null for shared tokens.
users.get("/api/auth/me", requireRole("admin", "app"), async (c) => c.json(await me(c.get("principal"))));

// Switches the firm this session works in; the role follows the membership in that firm.
users.post("/api/auth/tenant", requireRole("admin", "app"), async (c) => {
  const { user } = c.get("principal");
  if (!user) return c.json({ error: "Wspólny token nie ma firm" }, 400);
  const body = await c.req.json<{ tenantId?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const tenant = (await tenantsOf(user.id)).find((candidate) => candidate.id === body.tenantId);
  if (!tenant) return c.json({ error: "Nie ma takiej firmy" }, 404);
  await sql`update sessions set tenant_id = ${tenant.id} where token_hash = ${sessionTokenHash(bearerToken(c.req.header("authorization"))!)}`;
  const operator = c.get("principal").operator;
  return c.json(await me({ role: operator ? "admin" : roleOf(tenant.role), user, operator, tenant }));
});

users.post("/api/auth/logout", requireRole("admin", "app"), async (c) => {
  if (c.get("principal").user) await revokeSession(bearerToken(c.req.header("authorization"))!);
  return c.body(null, 204);
});

// Changing the password logs out every other device.
users.post("/api/auth/password", requireRole("admin", "app"), async (c) => {
  const { user } = c.get("principal");
  if (!user) return c.json({ error: "Wspólny token nie ma hasła" }, 400);
  const body = await c.req.json<{ currentPassword?: unknown; newPassword?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const [row] = await sql<{ passwordHash: string }[]>`select password_hash as "passwordHash" from users where id = ${user.id}`;
  if (typeof body.currentPassword !== "string" || !(await verifyPassword(row?.passwordHash, body.currentPassword))) {
    return c.json({ error: "Nieprawidłowe obecne hasło" }, 400);
  }
  const problem = passwordProblem(body.newPassword);
  if (problem) return c.json({ error: problem }, 400);
  await sql`update users set password_hash = ${await hashPassword(body.newPassword as string)} where id = ${user.id}`;
  await revokeUserSessions(user.id, bearerToken(c.req.header("authorization")));
  return c.body(null, 204);
});

// People of the firm with their role in it. An operator outside a firm sees every account and its firms.
users.get("/api/users", requireRole("admin"), requireTenantOwner, async (c) => {
  const tenantId = scopeTenant(c.get("principal"), c.req.query("tenantId"));
  if (tenantId) {
    return c.json(await sql`
      select ${userColumns}, m.role, m.blocked_at is not null as blocked,
        coalesce((select array_agg(pm.project_id order by pm.created_at) from project_members pm
          where pm.user_id = u.id and pm.tenant_id = m.tenant_id), '{}') as "projectIds"
      from tenant_members m join users u on u.id = m.user_id
      where m.tenant_id = ${tenantId} order by m.created_at`);
  }
  return c.json(await sql`
    select ${userColumns}, u.role as "globalRole",
      coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name, 'role', m.role) order by m.created_at)
        from tenant_members m join tenants t on t.id = m.tenant_id where m.user_id = u.id), '[]') as tenants
    from users u order by u.created_at`);
});

// A new account joins only the firm it is created in.
users.post("/api/users", requireRole("admin"), requireTenantOwner, async (c) => {
  const body = await c.req.json<{ email?: unknown; name?: unknown; password?: unknown; role?: unknown; tenantId?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email.trim())) return c.json({ error: "Podaj poprawny e-mail" }, 400);
  const role = tenantRole(body.role);
  if (!role) return c.json({ error: ROLE_ERROR }, 400);
  const problem = passwordProblem(body.password);
  if (problem) return c.json({ error: problem }, 400);
  const principal = c.get("principal");
  const tenantId = scopeTenant(principal, typeof body.tenantId === "string" ? body.tenantId : undefined) ?? (await defaultTenantId());
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, name, password_hash)
    values (${normalizeEmail(body.email)}, ${name}, ${await hashPassword(body.password as string)})
    on conflict (email) do nothing
    returning id`;
  if (!user) return c.json({ error: "Konto z tym e-mailem już istnieje" }, 409);
  await sql`insert into tenant_members (tenant_id, user_id, role) values (${tenantId}, ${user.id}, ${role})`;
  const [created] = await memberRow(tenantId, user.id);
  return c.json(created, 201);
});

// Name, password and disabling change the whole account, so a firm may change them only for its own people who
// belong to no other firm. Disabling an account or setting a new password logs the user out everywhere.
// `blocked` shuts the person out of this firm only.
users.patch("/api/users/:id", requireRole("admin"), requireTenantOwner, async (c) => {
  const id = c.req.param("id");
  const principal = c.get("principal");
  const self = principal.user?.id === id;
  const body = await c.req.json<{ name?: unknown; role?: unknown; password?: unknown; disabled?: unknown; blocked?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const role = body.role === undefined ? undefined : tenantRole(body.role);
  if (role === null) return c.json({ error: ROLE_ERROR }, 400);
  if (body.password !== undefined) {
    const problem = passwordProblem(body.password);
    if (problem) return c.json({ error: problem }, 400);
  }
  if (self && (body.disabled === true || body.blocked === true || (role && role !== "owner"))) {
    return c.json({ error: "Nie możesz wyłączyć ani zdegradować własnego konta" }, 400);
  }
  const tenantId = scopeTenant(principal, c.req.query("tenantId"));
  const [target] = isUuid(id)
    ? await sql<{ inTenant: boolean; elsewhere: boolean }[]>`
        select exists (select 1 from tenant_members where user_id = u.id and tenant_id = ${tenantId}) as "inTenant",
          exists (select 1 from tenant_members where user_id = u.id and tenant_id is distinct from ${tenantId}) as elsewhere
        from users u where u.id = ${id}`
    : [];
  if (!target || (!principal.operator && !target.inTenant)) return c.json({ error: "Nie ma takiego użytkownika" }, 404);
  const accountWide = typeof body.name === "string" || typeof body.password === "string" || typeof body.disabled === "boolean";
  if (accountWide && !principal.operator && target.elsewhere) {
    return c.json({ error: "Konto należy też do innej firmy, zmienia je tylko jego właściciel" }, 403);
  }
  if ((role || typeof body.blocked === "boolean") && !target.inTenant) return c.json({ error: "Ta osoba nie należy do firmy" }, 400);

  if (typeof body.name === "string") await sql`update users set name = ${body.name.trim()} where id = ${id}`;
  if (role) await sql`update tenant_members set role = ${role} where tenant_id = ${tenantId} and user_id = ${id}`;
  if (typeof body.password === "string") await sql`update users set password_hash = ${await hashPassword(body.password)} where id = ${id}`;
  if (typeof body.disabled === "boolean") {
    await sql`update users set disabled_at = ${body.disabled ? sql`coalesce(disabled_at, now())` : null} where id = ${id}`;
  }
  // Blocking works in this firm only: the account keeps its other firms, its sessions in this one end.
  if (typeof body.blocked === "boolean") {
    await sql`
      update tenant_members set blocked_at = ${body.blocked ? sql`coalesce(blocked_at, now())` : null}
      where tenant_id = ${tenantId} and user_id = ${id}`;
    if (body.blocked) await sql`delete from sessions where user_id = ${id} and tenant_id = ${tenantId}`;
  }
  if (body.disabled === true || typeof body.password === "string") await revokeUserSessions(id);
  const [user] = tenantId && target.inTenant ? await memberRow(tenantId, id) : await sql`select ${userColumns} from users u where u.id = ${id}`;
  return c.json(user);
});

// A firm removes a person from itself (and its projects); an account left without any firm is deleted.
// An operator outside a firm deletes the account.
users.delete("/api/users/:id", requireRole("admin"), requireTenantOwner, async (c) => {
  const id = c.req.param("id");
  const principal = c.get("principal");
  if (principal.user?.id === id) return c.json({ error: "Nie możesz usunąć własnego konta" }, 400);
  if (!isUuid(id)) return c.body(null, 204);
  const tenantId = scopeTenant(principal, c.req.query("tenantId"));
  if (!tenantId) {
    await sql`delete from users where id = ${id}`;
    return c.body(null, 204);
  }
  await sql.begin(async (tx) => {
    await tx`delete from project_members where user_id = ${id} and tenant_id = ${tenantId}`;
    const removed = await tx`delete from tenant_members where user_id = ${id} and tenant_id = ${tenantId} returning 1`;
    if (removed.length > 0) {
      await tx`delete from users where id = ${id} and role <> 'operator' and not exists (select 1 from tenant_members where user_id = ${id})`;
    }
  });
  return c.body(null, 204);
});

users.get("/api/projects/:id/members", requireRole("admin"), requireProjectAccess(), async (c) =>
  c.json(await sql`
    select ${userColumns}, tm.role from project_members m join users u on u.id = m.user_id
    join tenant_members tm on tm.user_id = m.user_id and tm.tenant_id = m.tenant_id
    where m.project_id = ${c.req.param("id")} order by m.created_at`),
);

// Only people of the project's firm can be added to it.
users.put("/api/projects/:id/members/:userId", requireRole("admin"), requireProjectAccess(), async (c) => {
  const [member] = isUuid(c.req.param("userId"))
    ? await sql`
        select 1 from tenant_members m join projects p on p.tenant_id = m.tenant_id
        where p.id = ${c.req.param("id")} and m.user_id = ${c.req.param("userId")}`
    : [];
  if (!member) return c.json({ error: "Nie ma takiego użytkownika" }, 404);
  await sql`insert into project_members (project_id, user_id) values (${c.req.param("id")}, ${c.req.param("userId")}) on conflict do nothing`;
  return c.body(null, 204);
});

users.delete("/api/projects/:id/members/:userId", requireRole("admin"), requireProjectAccess(), async (c) => {
  if (isUuid(c.req.param("userId"))) {
    await sql`delete from project_members where project_id = ${c.req.param("id")} and user_id = ${c.req.param("userId")}`;
  }
  return c.body(null, 204);
});

const SHARE_LINK_DAYS = 7;
const MAX_SHARE_LINK_DAYS = 90;

// A read-only link to one project (#82, #84 build on it). Only a hash of the token is stored.
users.post("/api/projects/:id/share-links", requireRole("admin"), requireProjectAccess(), async (c) => {
  const body = await c.req.json<{ days?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const days = typeof body.days === "number" && body.days >= 1 && body.days <= MAX_SHARE_LINK_DAYS ? Math.floor(body.days) : SHARE_LINK_DAYS;
  const token = `bl_${randomBytes(32).toString("base64url")}`;
  const [link] = await sql<{ expiresAt: Date }[]>`
    insert into share_links (token_hash, project_id, created_by, expires_at)
    values (${sessionTokenHash(token)}, ${c.req.param("id")}, ${c.get("principal").user?.id ?? null}, now() + make_interval(days => ${days}))
    returning expires_at as "expiresAt"`;
  return c.json({ token, expiresAt: link!.expiresAt }, 201);
});

users.get("/api/share/:token", async (c) => {
  const [project] = await sql`
    select p.id, p.name, l.expires_at as "expiresAt" from share_links l
    join projects p on p.id = l.project_id and p.tenant_id = l.tenant_id
    join tenants t on t.id = l.tenant_id and t.disabled_at is null
    where l.token_hash = ${sessionTokenHash(c.req.param("token"))} and l.expires_at > now()`;
  return project ? c.json(project) : c.json({ error: "Link wygasł albo nie istnieje" }, 404);
});
