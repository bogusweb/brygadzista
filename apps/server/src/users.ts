import { Hono } from "hono";
import {
  bearerToken,
  createSession,
  hashPassword,
  isUuid,
  normalizeEmail,
  requireProjectAccess,
  requireRole,
  revokeSession,
  revokeUserSessions,
  verifyPassword,
  type AuthEnv,
  type UserRole,
} from "./auth.js";
import { defaultTenantId, sql } from "./db.js";
import { limiters, tooManyRequests } from "./rate-limit.js";

const MIN_PASSWORD_LENGTH = 10;
const USER_ROLES: UserRole[] = ["owner", "contractor"];

const passwordProblem = (password: unknown) =>
  typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH
    ? `Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków`
    : null;

const isUserRole = (role: unknown): role is UserRole => USER_ROLES.includes(role as UserRole);

// Behind Openship's proxy the client address is the first entry of X-Forwarded-For.
const clientIp = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

const userColumns = sql`u.id, u.email, u.name, u.role, u.disabled_at is not null as disabled, u.created_at as "createdAt"`;

export const users = new Hono<AuthEnv>();

users.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ email?: unknown; password?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.email !== "string" || typeof body.password !== "string") return c.json({ error: "Podaj e-mail i hasło" }, 400);
  const email = normalizeEmail(body.email);
  const retryAfter = limiters.loginIp.hit(clientIp(c.req.raw)) ?? limiters.loginEmail.hit(email);
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const [user] = await sql<{ id: string; email: string; name: string; role: UserRole; passwordHash: string; disabled: boolean }[]>`
    select id, email, name, role, password_hash as "passwordHash", disabled_at is not null as disabled
    from users where email = ${email}`;
  if (!(await verifyPassword(user?.passwordHash, body.password)) || !user || user.disabled) {
    return c.json({ error: "Nieprawidłowy e-mail lub hasło" }, 401);
  }
  limiters.loginEmail.forget(email);
  const session = await createSession(user.id);
  return c.json({
    token: session.token,
    expiresAt: session.expiresAt,
    role: user.role === "owner" ? "admin" : "app",
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// Lets a client check a token (and which role it carries) before storing it. `user` is null for shared tokens.
users.get("/api/auth/me", requireRole("admin", "app"), (c) => {
  const { role, user } = c.get("principal");
  return c.json({ role, user });
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

users.get("/api/users", requireRole("admin"), async (c) =>
  c.json(await sql`
    select ${userColumns},
      coalesce((select array_agg(m.project_id order by m.created_at) from project_members m where m.user_id = u.id), '{}') as "projectIds"
    from users u order by u.created_at`),
);

users.post("/api/users", requireRole("admin"), async (c) => {
  const body = await c.req.json<{ email?: unknown; name?: unknown; password?: unknown; role?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email.trim())) return c.json({ error: "Podaj poprawny e-mail" }, 400);
  if (!isUserRole(body.role)) return c.json({ error: "Rola to owner albo contractor" }, 400);
  const problem = passwordProblem(body.password);
  if (problem) return c.json({ error: problem }, 400);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, name, password_hash, role)
    values (${normalizeEmail(body.email)}, ${name}, ${await hashPassword(body.password as string)}, ${body.role})
    on conflict (email) do nothing
    returning id, email, name, role, false as disabled, created_at as "createdAt"`;
  if (user) {
    await sql`
      insert into tenant_members (tenant_id, user_id, role)
      values (${await defaultTenantId()}, ${user.id}, ${body.role === "owner" ? "owner" : "worker"})`;
  }
  return user ? c.json(user, 201) : c.json({ error: "Konto z tym e-mailem już istnieje" }, 409);
});

// Disabling an account or setting a new password logs the user out everywhere.
users.patch("/api/users/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const self = c.get("principal").user?.id === id;
  const body = await c.req.json<{ name?: unknown; role?: unknown; password?: unknown; disabled?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (body.role !== undefined && !isUserRole(body.role)) return c.json({ error: "Rola to owner albo contractor" }, 400);
  if (body.password !== undefined) {
    const problem = passwordProblem(body.password);
    if (problem) return c.json({ error: problem }, 400);
  }
  if (self && (body.disabled === true || body.role === "contractor")) {
    return c.json({ error: "Nie możesz wyłączyć ani zdegradować własnego konta" }, 400);
  }
  const [exists] = isUuid(id) ? await sql`select 1 from users where id = ${id}` : [];
  if (!exists) return c.json({ error: "Nie ma takiego użytkownika" }, 404);

  if (typeof body.name === "string") await sql`update users set name = ${body.name.trim()} where id = ${id}`;
  if (isUserRole(body.role)) await sql`update users set role = ${body.role} where id = ${id}`;
  if (typeof body.password === "string") await sql`update users set password_hash = ${await hashPassword(body.password)} where id = ${id}`;
  if (typeof body.disabled === "boolean") {
    await sql`update users set disabled_at = ${body.disabled ? sql`coalesce(disabled_at, now())` : null} where id = ${id}`;
  }
  if (body.disabled === true || typeof body.password === "string") await revokeUserSessions(id);
  const [user] = await sql`select ${userColumns} from users u where u.id = ${id}`;
  return c.json(user);
});

users.delete("/api/users/:id", requireRole("admin"), async (c) => {
  if (c.get("principal").user?.id === c.req.param("id")) return c.json({ error: "Nie możesz usunąć własnego konta" }, 400);
  if (isUuid(c.req.param("id"))) await sql`delete from users where id = ${c.req.param("id")}`;
  return c.body(null, 204);
});

users.get("/api/projects/:id/members", requireRole("admin"), requireProjectAccess(), async (c) =>
  c.json(await sql`
    select ${userColumns} from project_members m join users u on u.id = m.user_id
    where m.project_id = ${c.req.param("id")} order by m.created_at`),
);

users.put("/api/projects/:id/members/:userId", requireRole("admin"), requireProjectAccess(), async (c) => {
  const [user] = isUuid(c.req.param("userId")) ? await sql`select 1 from users where id = ${c.req.param("userId")}` : [];
  if (!user) return c.json({ error: "Nie ma takiego użytkownika" }, 404);
  await sql`insert into project_members (project_id, user_id) values (${c.req.param("id")}, ${c.req.param("userId")}) on conflict do nothing`;
  return c.body(null, 204);
});

users.delete("/api/projects/:id/members/:userId", requireRole("admin"), requireProjectAccess(), async (c) => {
  if (isUuid(c.req.param("userId"))) {
    await sql`delete from project_members where project_id = ${c.req.param("id")} and user_id = ${c.req.param("userId")}`;
  }
  return c.body(null, 204);
});
