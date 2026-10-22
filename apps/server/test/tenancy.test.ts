import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { ADMIN, PASSWORD, addMember, createOperator, createProject, createTenant, createUser, login, resetDatabase } from "./helpers.js";

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

let firmA: string;
let firmB: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  await resetDatabase();
  firmA = await createTenant("Firma A");
  firmB = await createTenant("Firma B");
  projectA = await createProject("Dom A", firmA);
  projectB = await createProject("Dom B", firmB);
  await createUser("szef@a.pl", "owner", PASSWORD, firmA);
  await createUser("szef@b.pl", "owner", PASSWORD, firmB);
});

afterAll(async () => {
  await sql.end();
});

const projectIds = async (headers: Record<string, string>) =>
  ((await (await app.request("/api/projects", { headers })).json()) as { id: string }[]).map((project) => project.id);

describe("firms in the session", () => {
  it("logs an owner into their firm and lists only its projects", async () => {
    const response = await app.request("/api/auth/login", json("POST", { email: "szef@a.pl", password: PASSWORD }));
    const body = (await response.json()) as { token: string; role: string; tenant: { id: string; name: string; role: string } };
    expect(body).toMatchObject({ role: "admin", tenant: { id: firmA, name: "Firma A", role: "owner" } });

    const owner = { authorization: `Bearer ${body.token}` };
    expect(await projectIds(owner)).toEqual([projectA]);
    expect((await app.request(`/api/projects/${projectB}/documents`, { headers: owner })).status).toBe(404);
    expect((await app.request(`/api/projects/${projectB}`, { method: "DELETE", headers: owner })).status).toBe(404);
    expect(await sql`select 1 from projects where id = ${projectB}`).toHaveLength(1);
  });

  it("creates a project in the session's firm, ignoring a firm sent in the body", async () => {
    const owner = await login("szef@a.pl");
    const created = await app.request("/api/projects", json("POST", { name: "Nowy", tenantId: firmB }, owner));
    const { id } = (await created.json()) as { id: string };

    const [project] = await sql`select tenant_id from projects where id = ${id}`;
    expect(project!.tenant_id).toBe(firmA);
  });

  it("switches between firms of a person who belongs to two", async () => {
    const both = await createUser("kierownik@x.pl", "manager", PASSWORD, firmA);
    await sql`insert into tenant_members (tenant_id, user_id, role) values (${firmB}, ${both}, 'worker')`;
    await addMember(projectB, both);
    const session = await login("kierownik@x.pl");
    expect(await projectIds(session)).toEqual([projectA]);

    const switched = await app.request("/api/auth/tenant", json("POST", { tenantId: firmB }, session));
    expect(await switched.json()).toMatchObject({ role: "app", tenant: { id: firmB, role: "worker" } });
    expect(await projectIds(session)).toEqual([projectB]);
    expect((await app.request("/api/auth/tenant", json("POST", { tenantId: crypto.randomUUID() }, session))).status).toBe(404);
  });

  it("drops a blocked firm from the session", async () => {
    const owner = await login("szef@a.pl");
    await sql`update tenants set disabled_at = now() where id = ${firmA}`;

    expect(await projectIds(owner)).toEqual([]);
    expect((await app.request("/api/auth/login", json("POST", { email: "szef@a.pl", password: PASSWORD }))).status).toBe(403);
  });
});

describe("people of a firm", () => {
  it("lists and creates people only in the owner's firm", async () => {
    const owner = await login("szef@a.pl");
    const created = await app.request("/api/users", json("POST", { email: "ola@a.pl", password: PASSWORD, role: "worker" }, owner));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ email: "ola@a.pl", role: "worker", projectIds: [] });

    const list = (await (await app.request("/api/users", { headers: owner })).json()) as { email: string }[];
    expect(list.map((user) => user.email).sort()).toEqual(["ola@a.pl", "szef@a.pl"]);
  });

  it("does not let a firm touch another firm's people", async () => {
    const owner = await login("szef@a.pl");
    const [other] = await sql<{ id: string }[]>`select id from users where email = 'szef@b.pl'`;

    expect((await app.request(`/api/users/${other!.id}`, json("PATCH", { disabled: true }, owner))).status).toBe(404);
    expect((await app.request(`/api/projects/${projectA}/members/${other!.id}`, { method: "PUT", headers: owner })).status).toBe(404);
    await app.request(`/api/users/${other!.id}`, { method: "DELETE", headers: owner });
    expect(await sql`select 1 from users where id = ${other!.id}`).toHaveLength(1);
  });

  it("keeps people management for owners: a manager runs projects only", async () => {
    await createUser("kierownik@a.pl", "manager", PASSWORD, firmA);
    const manager = await login("kierownik@a.pl");

    expect((await app.request("/api/users", { headers: manager })).status).toBe(403);
    expect((await app.request("/api/projects", json("POST", { name: "Hala" }, manager))).status).toBe(201);
  });

  it("removes a person from the firm and deletes an account left without one", async () => {
    const owner = await login("szef@a.pl");
    const workerId = await createUser("ola@a.pl", "worker", PASSWORD, firmA);
    await addMember(projectA, workerId);

    expect((await app.request(`/api/users/${workerId}`, { method: "DELETE", headers: owner })).status).toBe(204);
    expect(await sql`select 1 from users where id = ${workerId}`).toHaveLength(0);
  });

  it("does not change the password of an account that also works for another firm", async () => {
    const owner = await login("szef@a.pl");
    const shared = await createUser("ola@a.pl", "worker", PASSWORD, firmA);
    await sql`insert into tenant_members (tenant_id, user_id, role) values (${firmB}, ${shared}, 'worker')`;

    expect((await app.request(`/api/users/${shared}`, json("PATCH", { password: "nowe-haslo-456" }, owner))).status).toBe(403);
    expect((await app.request(`/api/users/${shared}`, json("PATCH", { role: "manager" }, owner))).status).toBe(200);
  });
});

describe("operator", () => {
  it("sees every firm with ADMIN_TOKEN and with an operator account", async () => {
    await createOperator("operator@brygadzista.app");
    const operator = await login("operator@brygadzista.app");

    for (const headers of [ADMIN, operator]) {
      expect((await projectIds(headers)).sort()).toEqual([projectA, projectB].sort());
      expect((await app.request(`/api/projects/${projectB}/documents`, { headers })).status).toBe(200);
    }
    const users = (await (await app.request("/api/users", { headers: ADMIN })).json()) as { email: string; tenants: { name: string }[] }[];
    expect(users.find((user) => user.email === "szef@b.pl")?.tenants).toEqual([expect.objectContaining({ name: "Firma B", role: "owner" })]);
  });

  it("creates a project in a named firm", async () => {
    const created = await app.request("/api/projects", json("POST", { name: "Dla B", tenantId: firmB }, ADMIN));
    const { id } = (await created.json()) as { id: string };
    const [project] = await sql`select tenant_id from projects where id = ${id}`;
    expect(project!.tenant_id).toBe(firmB);
  });
});

describe("read-only links", () => {
  it("open one project until they expire", async () => {
    const owner = await login("szef@a.pl");
    const created = await app.request(`/api/projects/${projectA}/share-links`, json("POST", { days: 3 }, owner));
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };

    expect(await (await app.request(`/api/share/${token}`)).json()).toMatchObject({ id: projectA, name: "Dom A" });
    expect((await app.request(`/api/projects/${projectB}/share-links`, json("POST", {}, owner))).status).toBe(404);

    await sql`update share_links set expires_at = now() - interval '1 second'`;
    expect((await app.request(`/api/share/${token}`)).status).toBe(404);
  });

  it("are tied to the project's firm", async () => {
    await expect(
      sql`insert into share_links (token_hash, project_id, tenant_id, expires_at) values ('x', ${projectA}, ${firmB}, now())`,
    ).rejects.toThrow();
  });
});
