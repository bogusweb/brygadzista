import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono, type MiddlewareHandler } from "hono";
import { hashPassword, isUuid, normalizeEmail, requireRole, requireTenantOwner, sessionTokenHash, bearerToken, type AuthEnv, type Principal } from "./auth.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { tenantDir } from "./storage.js";

// What a firm used, per day (#94): agent runs and indexed pages. The operator panel shows the last 30 days.
export type UsageKind = "chat_runs" | "indexed_pages";

export const recordUsage = (tenantId: string, kind: UsageKind, amount = 1) =>
  sql`
    insert into tenant_usage (tenant_id, day, kind, amount) values (${tenantId}, current_date, ${kind}, ${amount})
    on conflict (tenant_id, day, kind) do update set amount = tenant_usage.amount + excluded.amount`;

// Every operator action on a firm is written down: entering it, blocking, exporting and deleting.
const audit = (principal: Principal, tenantId: string, tenantName: string, action: string) =>
  sql`
    insert into operator_audit (tenant_id, tenant_name, action, operator_id, operator_name)
    values (${tenantId}, ${tenantName}, ${action}, ${principal.user?.id ?? null}, ${principal.user?.email ?? "ADMIN_TOKEN"})`;

const tenantById = async (id: string) => {
  if (!isUuid(id)) return null;
  const [tenant] = await sql<{ id: string; name: string }[]>`select id, name from tenants where id = ${id}`;
  return tenant ?? null;
};

// Every row of the firm as JSON, table by table; embeddings are left out (they are rebuilt from the documents).
const tenantRows = async (tenantId: string) => {
  const tables = await sql<{ table: string }[]>`
    select distinct table_name as table from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id' and table_name not in ('sessions', 'operator_audit')
    order by 1`;
  const data: Record<string, unknown[]> = {};
  for (const { table } of tables) {
    const rows = await sql.unsafe<{ row: unknown }[]>(`select to_jsonb(t) - 'embedding' as row from ${table} t where tenant_id = $1`, [tenantId]);
    data[table] = rows.map((row) => row.row);
  }
  data.tenants = [...(await sql`select * from tenants where id = ${tenantId}`)];
  data.users = [...(await sql`
    select u.id, u.email, u.name, u.created_at, m.role from tenant_members m join users u on u.id = m.user_id where m.tenant_id = ${tenantId}`)];
  return data;
};

// A .tar.gz with data.json and the firm's directory (tenants/<id>/projects/…) as it lies under DATA_DIR. Uses the system tar.
export const exportTenant = async (tenantId: string): Promise<Readable> => {
  const work = await mkdtemp(path.join(tmpdir(), "brygadzista-export-"));
  await writeFile(path.join(work, "data.json"), JSON.stringify({ exportedAt: new Date().toISOString(), ...(await tenantRows(tenantId)) }, null, 1));
  const files = (await stat(tenantDir(tenantId)).catch(() => null)) ? [path.relative(config.dataDir, tenantDir(tenantId))] : [];
  const tar = spawn("tar", ["-czf", "-", "-C", work, "data.json", ...(files.length ? ["-C", config.dataDir, ...files] : [])]);
  tar.on("close", () => rm(work, { recursive: true, force: true }).catch(() => {}));
  tar.stderr.on("data", (chunk: Buffer) => console.error(`export ${tenantId}: ${chunk.toString().trim()}`));
  return tar.stdout;
};

// Removes the firm, all its rows (by cascade), its files, and accounts that belonged to no other firm.
export const deleteTenant = async (tenantId: string) => {
  const members = await sql<{ userId: string }[]>`select user_id as "userId" from tenant_members where tenant_id = ${tenantId}`;
  await sql`delete from tenants where id = ${tenantId}`;
  await rm(tenantDir(tenantId), { recursive: true, force: true });
  for (const { userId } of members) {
    await sql`delete from users where id = ${userId} and role <> 'operator' and not exists (select 1 from tenant_members where user_id = ${userId})`;
  }
};

const requireOperator: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("principal").operator) return c.json({ error: "Tylko dla operatora" }, 403);
  await next();
};

const exportResponse = (stream: Readable, name: string) =>
  new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]+/g, "_")}.tar.gz"`,
    },
  });

export const operator = new Hono<AuthEnv>();
operator.use("/api/operator/*", requireRole("admin"), requireOperator);

operator.get("/api/operator/tenants", async (c) =>
  c.json(await sql`
    select t.id, t.name, t.created_at as "createdAt", t.disabled_at is not null as disabled,
      (select count(*)::int from projects p where p.tenant_id = t.id) as "projectCount",
      (select count(*)::int from tenant_members m where m.tenant_id = t.id) as "memberCount",
      (select count(*)::int from documents d where d.tenant_id = t.id) as documents,
      (select count(*)::int from pages pg where pg.tenant_id = t.id) as pages,
      coalesce((select sum(amount)::int from tenant_usage u where u.tenant_id = t.id and u.kind = 'chat_runs'
        and u.day > current_date - 30), 0) as "chatRuns30d",
      coalesce((select sum(amount)::int from tenant_usage u where u.tenant_id = t.id and u.kind = 'indexed_pages'
        and u.day > current_date - 30), 0) as "indexedPages30d"
    from tenants t order by t.created_at`),
);

// A new firm, optionally with its first owner.
operator.post("/api/operator/tenants", async (c) => {
  const body = await c.req.json<{ name?: unknown; ownerEmail?: unknown; ownerName?: unknown; ownerPassword?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "Podaj nazwę firmy" }, 400);
  const withOwner = typeof body.ownerEmail === "string" && body.ownerEmail.trim() !== "";
  if (withOwner && (typeof body.ownerPassword !== "string" || body.ownerPassword.length < 10)) {
    return c.json({ error: "Hasło właściciela musi mieć co najmniej 10 znaków" }, 400);
  }
  const passwordHash = withOwner ? await hashPassword(body.ownerPassword as string) : null;
  const result = await sql.begin(async (tx) => {
    const [tenant] = await tx<{ id: string; name: string }[]>`insert into tenants (name) values (${body.name as string}) returning id, name`;
    if (!withOwner) return { tenant: tenant! };
    const [user] = await tx<{ id: string }[]>`
      insert into users (email, name, password_hash)
      values (${normalizeEmail(body.ownerEmail as string)}, ${typeof body.ownerName === "string" ? body.ownerName.trim() : ""}, ${passwordHash})
      on conflict (email) do nothing returning id`;
    if (!user) return { conflict: true as const };
    await tx`insert into tenant_members (tenant_id, user_id, role) values (${tenant!.id}, ${user.id}, 'owner')`;
    return { tenant: tenant! };
  });
  if ("conflict" in result) return c.json({ error: "Konto z tym e-mailem już istnieje" }, 409);
  await audit(c.get("principal"), result.tenant.id, result.tenant.name, "create");
  return c.json(result.tenant, 201);
});

// Rename or block a firm. A blocked firm drops out of every session and its people cannot log in to it.
operator.patch("/api/operator/tenants/:id", async (c) => {
  const tenant = await tenantById(c.req.param("id"));
  if (!tenant) return c.json({ error: "Nie ma takiej firmy" }, 404);
  const body = await c.req.json<{ name?: unknown; disabled?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.name === "string" && body.name.trim()) {
    await sql`update tenants set name = ${body.name.trim()} where id = ${tenant.id}`;
    await audit(c.get("principal"), tenant.id, body.name.trim(), "rename");
  }
  if (typeof body.disabled === "boolean") {
    await sql`update tenants set disabled_at = ${body.disabled ? sql`coalesce(disabled_at, now())` : null} where id = ${tenant.id}`;
    await audit(c.get("principal"), tenant.id, tenant.name, body.disabled ? "block" : "unblock");
  }
  const [updated] = await sql`select id, name, disabled_at is not null as disabled from tenants where id = ${tenant.id}`;
  return c.json(updated);
});

// The operator's session works inside the firm (as its owner) until it leaves; entering is logged.
operator.post("/api/operator/tenants/:id/enter", async (c) => {
  const principal = c.get("principal");
  if (!principal.user) return c.json({ error: "Wejście do firmy wymaga konta operatora, nie ADMIN_TOKEN" }, 400);
  const tenant = await tenantById(c.req.param("id"));
  if (!tenant) return c.json({ error: "Nie ma takiej firmy" }, 404);
  await sql`update sessions set tenant_id = ${tenant.id} where token_hash = ${sessionTokenHash(bearerToken(c.req.header("authorization"))!)}`;
  await audit(principal, tenant.id, tenant.name, "enter");
  return c.json({ tenant: { ...tenant, role: "owner" } });
});

operator.post("/api/operator/leave", async (c) => {
  if (c.get("principal").user) {
    await sql`update sessions set tenant_id = null where token_hash = ${sessionTokenHash(bearerToken(c.req.header("authorization"))!)}`;
  }
  return c.body(null, 204);
});

operator.get("/api/operator/tenants/:id/export", async (c) => {
  const tenant = await tenantById(c.req.param("id"));
  if (!tenant) return c.json({ error: "Nie ma takiej firmy" }, 404);
  await audit(c.get("principal"), tenant.id, tenant.name, "export");
  return exportResponse(await exportTenant(tenant.id), tenant.name);
});

// Deleting a firm cannot be undone, so the request repeats the firm's name.
operator.delete("/api/operator/tenants/:id", async (c) => {
  const tenant = await tenantById(c.req.param("id"));
  if (!tenant) return c.json({ error: "Nie ma takiej firmy" }, 404);
  const body = await c.req.json<{ confirm?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (body.confirm !== tenant.name) return c.json({ error: "Potwierdź usunięcie, podając dokładną nazwę firmy" }, 400);
  await audit(c.get("principal"), tenant.id, tenant.name, "delete");
  await deleteTenant(tenant.id);
  return c.body(null, 204);
});

operator.get("/api/operator/audit", async (c) =>
  c.json(await sql`
    select id, tenant_id as "tenantId", tenant_name as "tenantName", action, operator_name as "operatorName", created_at as "createdAt"
    from operator_audit order by created_at desc limit 200`),
);

// The owner of a firm downloads all of its data (RODO).
operator.get("/api/tenant/export", requireRole("admin"), requireTenantOwner, async (c) => {
  const tenant = c.get("principal").tenant;
  if (!tenant) return c.json({ error: "Brak firmy" }, 400);
  return exportResponse(await exportTenant(tenant.id), tenant.name);
});
