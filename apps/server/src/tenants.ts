import { Hono, type MiddlewareHandler } from "hono";
import { randomBytes } from "node:crypto";
import {
  hashPassword,
  isUuid,
  normalizeEmail,
  requireRole,
  requireTenantOwner,
  sessionTokenHash,
  verifyPassword,
  type AuthEnv,
  type TenantRole,
} from "./auth.js";
import { sql } from "./db.js";
import { limiters, tooManyRequests } from "./rate-limit.js";
import { clientIp, passwordProblem, scopeTenant, tenantRole, ROLE_ERROR } from "./users.js";

const INVITE_DAYS = 7;
const MAX_INVITE_DAYS = 30;
// Accepted invitations stay on the list for a while so the owner sees who joined.
const ACCEPTED_VISIBLE_DAYS = 30;

const requireOperator: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("principal").operator) return c.json({ error: "Tylko operator serwisu" }, 403);
  await next();
};

const firmProblem = (name: unknown) =>
  typeof name !== "string" || !name.trim() ? "Podaj nazwę firmy" : name.trim().length > 120 ? "Nazwa firmy może mieć najwyżej 120 znaków" : null;

export const tenants = new Hono<AuthEnv>();

// Every firm, for the operator's firm switcher. The full operator panel (usage, blocking a firm) is #94.
tenants.get("/api/tenants", requireRole("admin"), requireOperator, async (c) =>
  c.json(await sql`
    select t.id, t.name, t.created_at as "createdAt", t.disabled_at is not null as disabled,
      (select count(*)::int from tenant_members m where m.tenant_id = t.id) as "memberCount",
      (select count(*)::int from projects p where p.tenant_id = t.id) as "projectCount"
    from tenants t order by t.created_at`),
);

// An operator opens a new firm; its first owner joins through an invitation.
tenants.post("/api/tenants", requireRole("admin"), requireOperator, async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const problem = firmProblem(body.name);
  if (problem) return c.json({ error: problem }, 400);
  const [tenant] = await sql`insert into tenants (name) values (${(body.name as string).trim()}) returning id, name`;
  return c.json(tenant, 201);
});

tenants.patch("/api/tenant", requireRole("admin"), requireTenantOwner, async (c) => {
  const tenantId = scopeTenant(c.get("principal"), c.req.query("tenantId"));
  if (!tenantId) return c.json({ error: "Wybierz firmę" }, 400);
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const problem = firmProblem(body.name);
  if (problem) return c.json({ error: problem }, 400);
  const [tenant] = await sql`update tenants set name = ${(body.name as string).trim()} where id = ${tenantId} returning id, name`;
  return tenant ? c.json(tenant) : c.json({ error: "Nie ma takiej firmy" }, 404);
});

const inviteColumns = sql`
  i.id, i.email, i.role, i.project_ids as "projectIds", i.created_at as "createdAt", i.expires_at as "expiresAt",
  i.accepted_at as "acceptedAt", u.name as "acceptedByName", u.email as "acceptedByEmail"`;

tenants.get("/api/invites", requireRole("admin"), requireTenantOwner, async (c) => {
  const tenantId = scopeTenant(c.get("principal"), c.req.query("tenantId"));
  if (!tenantId) return c.json({ error: "Wybierz firmę" }, 400);
  return c.json(await sql`
    select ${inviteColumns} from tenant_invites i left join users u on u.id = i.accepted_by
    where i.tenant_id = ${tenantId}
      and (i.accepted_at is null or i.accepted_at > now() - make_interval(days => ${ACCEPTED_VISIBLE_DAYS}))
    order by i.created_at desc`);
});

// The token is returned once; only its hash is kept, so a lost link means a new invitation.
tenants.post("/api/invites", requireRole("admin"), requireTenantOwner, async (c) => {
  const principal = c.get("principal");
  const tenantId = scopeTenant(principal, c.req.query("tenantId"));
  if (!tenantId) return c.json({ error: "Wybierz firmę" }, 400);
  const body = await c.req.json<{ role?: unknown; email?: unknown; days?: unknown; projectIds?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const role = tenantRole(body.role);
  if (!role) return c.json({ error: ROLE_ERROR }, 400);
  let email: string | null = null;
  if (typeof body.email === "string" && body.email.trim()) {
    if (!/^[^@\s]+@[^@\s]+$/.test(body.email.trim())) return c.json({ error: "Podaj poprawny e-mail" }, 400);
    email = normalizeEmail(body.email);
  }
  const days = typeof body.days === "number" && body.days >= 1 && body.days <= MAX_INVITE_DAYS ? Math.floor(body.days) : INVITE_DAYS;
  const requestedProjects = Array.isArray(body.projectIds) ? body.projectIds.filter((id): id is string => typeof id === "string" && isUuid(id)) : [];
  const projectIds = requestedProjects.length
    ? (await sql<{ id: string }[]>`select id from projects where tenant_id = ${tenantId} and id = any(${requestedProjects}::uuid[])`).map((p) => p.id)
    : [];
  const token = `bi_${randomBytes(32).toString("base64url")}`;
  const [invite] = await sql`
    insert into tenant_invites (token_hash, tenant_id, email, role, project_ids, created_by, expires_at)
    values (${sessionTokenHash(token)}, ${tenantId}, ${email}, ${role}, ${projectIds}::uuid[], ${principal.user?.id ?? null},
      now() + make_interval(days => ${days}))
    returning id, email, role, project_ids as "projectIds", created_at as "createdAt", expires_at as "expiresAt"`;
  return c.json({ ...invite, token }, 201);
});

tenants.delete("/api/invites/:id", requireRole("admin"), requireTenantOwner, async (c) => {
  const tenantId = scopeTenant(c.get("principal"), c.req.query("tenantId"));
  const revoked = tenantId && isUuid(c.req.param("id"))
    ? await sql`delete from tenant_invites where id = ${c.req.param("id")} and tenant_id = ${tenantId} and accepted_at is null returning 1`
    : [];
  return revoked.length > 0 ? c.body(null, 204) : c.json({ error: "Nie ma takiego zaproszenia" }, 404);
});

type OpenInvite = { id: string; tenantId: string; tenantName: string; email: string | null; role: TenantRole; projectIds: string[]; expiresAt: Date };

const openInvite = async (token: string) => {
  const [invite] = await sql<OpenInvite[]>`
    select i.id, i.tenant_id as "tenantId", t.name as "tenantName", i.email, i.role, i.project_ids as "projectIds", i.expires_at as "expiresAt"
    from tenant_invites i join tenants t on t.id = i.tenant_id and t.disabled_at is null
    where i.token_hash = ${sessionTokenHash(token)} and i.accepted_at is null and i.expires_at > now()`;
  return invite ?? null;
};

class Refusal extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const GONE = "Zaproszenie wygasło, zostało już użyte albo odwołane. Poproś o nowe.";

// What the invitation page shows before the person signs up. No login needed: the token is the access.
tenants.get("/api/invites/token/:token", async (c) => {
  const invite = await openInvite(c.req.param("token"));
  if (!invite) return c.json({ error: GONE }, 404);
  return c.json({ tenantName: invite.tenantName, email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
});

// Creates the account in this firm only, or adds an existing account (after its password) to the firm.
tenants.post("/api/invites/token/:token/accept", async (c) => {
  const retryAfter = limiters.loginIp.hit(clientIp(c.req.raw));
  if (retryAfter !== null) return tooManyRequests(retryAfter);
  const invite = await openInvite(c.req.param("token"));
  if (!invite) return c.json({ error: GONE }, 404);
  const body = await c.req.json<{ email?: unknown; name?: unknown; password?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const rawEmail = typeof body.email === "string" ? body.email : invite.email;
  if (!rawEmail || !/^[^@\s]+@[^@\s]+$/.test(rawEmail.trim())) return c.json({ error: "Podaj poprawny e-mail" }, 400);
  const email = normalizeEmail(rawEmail);
  if (invite.email && email !== invite.email) return c.json({ error: "To zaproszenie jest na inny adres e-mail" }, 400);
  if (typeof body.password !== "string") return c.json({ error: "Podaj hasło" }, 400);

  const [existing] = await sql<{ id: string; passwordHash: string; disabled: boolean }[]>`
    select id, password_hash as "passwordHash", disabled_at is not null as disabled from users where email = ${email}`;
  let passwordHash: string | null = null;
  if (existing) {
    if (!(await verifyPassword(existing.passwordHash, body.password)) || existing.disabled) {
      return c.json({ error: "Konto z tym e-mailem już istnieje. Podaj jego obecne hasło." }, 401);
    }
  } else {
    const problem = passwordProblem(body.password);
    if (problem) return c.json({ error: problem }, 400);
    passwordHash = await hashPassword(body.password);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";

  // Any refusal inside throws, so the claim rolls back and the link still works for a second try.
  try {
    await sql.begin(async (tx) => {
      const [claimed] = await tx`
        update tenant_invites set accepted_at = now()
        where id = ${invite.id} and accepted_at is null and expires_at > now() returning id`;
      if (!claimed) throw new Refusal(404, GONE);
      let userId = existing?.id;
      if (!userId) {
        const [created] = await tx<{ id: string }[]>`
          insert into users (email, name, password_hash) values (${email}, ${name}, ${passwordHash!})
          on conflict (email) do nothing returning id`;
        if (!created) throw new Refusal(409, "Konto z tym e-mailem właśnie powstało. Spróbuj ponownie.");
        userId = created.id;
      }
      const [joined] = await tx`
        insert into tenant_members (tenant_id, user_id, role) values (${invite.tenantId}, ${userId}, ${invite.role})
        on conflict do nothing returning 1`;
      if (!joined) throw new Refusal(409, "To konto już należy do tej firmy. Zaloguj się.");
      await tx`update tenant_invites set accepted_by = ${userId} where id = ${invite.id}`;
      await tx`
        insert into project_members (project_id, user_id)
        select id, ${userId} from projects where tenant_id = ${invite.tenantId} and id = any(${invite.projectIds}::uuid[])
        on conflict do nothing`;
    });
  } catch (error) {
    if (error instanceof Refusal) return c.json({ error: error.message }, error.status);
    throw error;
  }
  return c.json({ email, tenant: { id: invite.tenantId, name: invite.tenantName, role: invite.role } }, 201);
});
