import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { ADMIN, PASSWORD, createProject, createTenant, createUser, login, resetDatabase } from "./helpers.js";

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

let firmA: string;
let firmB: string;
let ownerA: Record<string, string>;

beforeEach(async () => {
  await resetDatabase();
  firmA = await createTenant("Firma A");
  firmB = await createTenant("Firma B");
  await createUser("szef@a.pl", "owner", PASSWORD, firmA);
  ownerA = await login("szef@a.pl");
});

afterAll(async () => {
  await sql.end();
});

const invite = async (body: Record<string, unknown>, headers = ownerA, query = "") => {
  const response = await app.request(`/api/invites${query}`, json("POST", body, headers));
  return { status: response.status, body: (await response.json()) as { id: string; token: string; error?: string } };
};

const accept = (token: string, body: Record<string, unknown>) => app.request(`/api/invites/token/${token}/accept`, json("POST", body));

describe("invitations", () => {
  it("create an account that joins only the inviting firm and the chosen projects", async () => {
    const dom = await createProject("Dom A", firmA);
    await createProject("Garaż A", firmA);
    const foreign = await createProject("Dom B", firmB);
    const created = await invite({ role: "worker", email: "Jan@Budowa.pl", projectIds: [dom, foreign] });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^bi_/);

    const preview = await app.request(`/api/invites/token/${created.body.token}`);
    expect(await preview.json()).toMatchObject({ tenantName: "Firma A", email: "jan@budowa.pl", role: "worker" });

    const response = await accept(created.body.token, { name: "Jan", password: "nowe-haslo-123" });
    expect(response.status).toBe(201);
    const jan = await login("jan@budowa.pl", "nowe-haslo-123");
    const me = (await (await app.request("/api/auth/me", { headers: jan })).json()) as { tenants: { name: string }[] };
    expect(me.tenants.map((tenant) => tenant.name)).toEqual(["Firma A"]);
    const projects = (await (await app.request("/api/projects", { headers: jan })).json()) as { name: string }[];
    expect(projects.map((project) => project.name)).toEqual(["Dom A"]);
  });

  it("work only once and not after they expire or are revoked", async () => {
    const used = await invite({ role: "worker" });
    expect((await accept(used.body.token, { email: "a@b.pl", password: "nowe-haslo-123" })).status).toBe(201);
    expect((await accept(used.body.token, { email: "c@d.pl", password: "nowe-haslo-123" })).status).toBe(404);

    const expired = await invite({ role: "worker" });
    await sql`update tenant_invites set expires_at = now() - interval '1 minute' where id = ${expired.body.id}`;
    expect((await app.request(`/api/invites/token/${expired.body.token}`)).status).toBe(404);

    const revoked = await invite({ role: "worker" });
    expect((await app.request(`/api/invites/${revoked.body.id}`, { method: "DELETE", headers: ownerA })).status).toBe(204);
    expect((await accept(revoked.body.token, { email: "e@f.pl", password: "nowe-haslo-123" })).status).toBe(404);
  });

  it("hold the e-mail they were made for and keep the link after a refused try", async () => {
    const created = await invite({ role: "manager", email: "kierownik@a.pl" });
    expect((await accept(created.body.token, { email: "inny@a.pl", password: "nowe-haslo-123" })).status).toBe(400);
    expect((await accept(created.body.token, { password: "krotkie" })).status).toBe(400);
    expect((await accept(created.body.token, { password: "nowe-haslo-123" })).status).toBe(201);
  });

  it("add an existing account to another firm only with its password", async () => {
    await createUser("ola@b.pl", "worker", PASSWORD, firmB);
    const created = await invite({ role: "worker" });
    expect((await accept(created.body.token, { email: "ola@b.pl", password: "zle-haslo-123" })).status).toBe(401);
    expect((await accept(created.body.token, { email: "ola@b.pl", password: PASSWORD })).status).toBe(201);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from tenant_members m join users u on u.id = m.user_id where u.email = 'ola@b.pl'`;
    expect(count).toBe(2);

    const again = await invite({ role: "worker" });
    expect((await accept(again.body.token, { email: "ola@b.pl", password: PASSWORD })).status).toBe(409);
    expect((await app.request(`/api/invites/token/${again.body.token}`)).status).toBe(200);
  });

  it("are listed and managed only by the owner of their firm", async () => {
    await createUser("kierownik@a.pl", "manager", PASSWORD, firmA);
    const manager = await login("kierownik@a.pl");
    expect((await invite({ role: "worker" }, manager)).status).toBe(403);

    await createUser("szef@b.pl", "owner", PASSWORD, firmB);
    const ownerB = await login("szef@b.pl");
    const created = await invite({ role: "worker", email: "x@a.pl" });
    const listB = (await (await app.request("/api/invites", { headers: ownerB })).json()) as unknown[];
    expect(listB).toEqual([]);
    await app.request(`/api/invites/${created.body.id}`, { method: "DELETE", headers: ownerB });
    const listA = (await (await app.request("/api/invites", { headers: ownerA })).json()) as { email: string }[];
    expect(listA.map((row) => row.email)).toEqual(["x@a.pl"]);
  });

  it("let the operator invite the first owner of a new firm", async () => {
    const response = await app.request("/api/tenants", json("POST", { name: "Nowa firma" }, ADMIN));
    const firm = (await response.json()) as { id: string };
    expect(response.status).toBe(201);
    const created = await invite({ role: "owner", email: "nowy@firma.pl" }, ADMIN, `?tenantId=${firm.id}`);
    expect(created.status).toBe(201);
    expect((await accept(created.body.token, { password: "nowe-haslo-123" })).status).toBe(201);
    const owner = await login("nowy@firma.pl", "nowe-haslo-123");
    const me = (await (await app.request("/api/auth/me", { headers: owner })).json()) as { role: string; tenant: { name: string } };
    expect(me).toMatchObject({ role: "admin", tenant: { name: "Nowa firma", role: "owner" } });
  });
});

describe("firm settings", () => {
  it("let the owner rename their firm, and only the operator list every firm", async () => {
    const renamed = await app.request("/api/tenant", json("PATCH", { name: "Firma A sp. z o.o." }, ownerA));
    expect(await renamed.json()).toMatchObject({ id: firmA, name: "Firma A sp. z o.o." });
    expect((await app.request("/api/tenants", { headers: ownerA })).status).toBe(403);
    const all = (await (await app.request("/api/tenants", { headers: ADMIN })).json()) as { name: string; memberCount: number }[];
    expect(all.map((tenant) => tenant.name)).toEqual(["Firma A sp. z o.o.", "Firma B"]);
  });

  it("block a person in one firm without touching their other firms", async () => {
    const olaId = await createUser("ola@b.pl", "worker", PASSWORD, firmB);
    await sql`insert into tenant_members (tenant_id, user_id, role) values (${firmA}, ${olaId}, 'worker')`;
    const ola = await login("ola@b.pl");
    await app.request("/api/auth/tenant", json("POST", { tenantId: firmA }, ola));

    const blocked = await app.request(`/api/users/${olaId}`, json("PATCH", { blocked: true }, ownerA));
    expect(await blocked.json()).toMatchObject({ blocked: true });
    // The session in firm A ended; a new login lands in firm B only.
    expect((await app.request("/api/auth/me", { headers: ola })).status).toBe(401);
    const again = await login("ola@b.pl");
    const me = (await (await app.request("/api/auth/me", { headers: again })).json()) as { tenants: { name: string }[] };
    expect(me.tenants.map((tenant) => tenant.name)).toEqual(["Firma B"]);

    await app.request(`/api/users/${olaId}`, json("PATCH", { blocked: false }, ownerA));
    const restored = (await (await app.request("/api/auth/me", { headers: again })).json()) as { tenants: unknown[] };
    expect(restored.tenants).toHaveLength(2);
  });
});
