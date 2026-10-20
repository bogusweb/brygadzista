import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { agentProjectId, principalFromToken } from "../src/auth.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { documentDir, pageImage } from "../src/storage.js";
import { ADMIN, APP, PASSWORD, addMember, createDocument, createProject, createUser, login, makePdf, resetDatabase } from "./helpers.js";

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const defaults = { appToken: config.appToken, chatRequestsPerMinute: config.chatRequestsPerMinute, uploadsPerHour: config.uploadsPerHour };

let assigned: string;
let other: string;
let contractorId: string;

beforeEach(async () => {
  await resetDatabase();
  assigned = await createProject("Hala sportowa");
  other = await createProject("Szkoła");
  contractorId = await createUser("jan@budowa.pl", "contractor");
  await addMember(assigned, contractorId);
});

afterEach(() => {
  Object.assign(config, defaults);
});

afterAll(async () => {
  await sql.end();
});

describe("login", () => {
  it("logs in with e-mail and password and returns a session for /api/auth/me", async () => {
    const response = await app.request("/api/auth/login", json("POST", { email: " Jan@Budowa.pl ", password: PASSWORD }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; role: string; user: { email: string; role: string } };
    expect(body).toMatchObject({ role: "app", user: { email: "jan@budowa.pl", role: "contractor" } });
    expect(body.token).toMatch(/^bs_/);

    const me = await app.request("/api/auth/me", { headers: { authorization: `Bearer ${body.token}` } });
    expect(await me.json()).toMatchObject({ role: "app", user: { id: contractorId, email: "jan@budowa.pl" } });
  });

  it("stores the password as an argon2id hash and only a hash of the session token", async () => {
    const auth = await login("jan@budowa.pl");

    const [user] = await sql`select password_hash from users where id = ${contractorId}`;
    expect(user!.password_hash).toMatch(/^\$argon2id\$/);
    const [session] = await sql`select token_hash from sessions`;
    expect(session!.token_hash).not.toContain(auth.authorization.slice("Bearer ".length));
  });

  it("rejects a wrong password, an unknown e-mail and a disabled account with the same message", async () => {
    await sql`insert into users (email, password_hash, role, disabled_at)
      select 'stary@budowa.pl', password_hash, 'contractor', now() from users where id = ${contractorId}`;

    for (const attempt of [
      { email: "jan@budowa.pl", password: "zle-haslo-123" },
      { email: "nikt@budowa.pl", password: PASSWORD },
      { email: "stary@budowa.pl", password: PASSWORD },
    ]) {
      const response = await app.request("/api/auth/login", json("POST", attempt));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Nieprawidłowy e-mail lub hasło" });
    }
  });

  it("limits login attempts per e-mail", async () => {
    const attempt = () => app.request("/api/auth/login", json("POST", { email: "jan@budowa.pl", password: "zle-haslo-123" }));
    for (let i = 0; i < config.loginAttemptsPer15Min; i++) expect((await attempt()).status).toBe(401);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Even the right password waits until the window is over.
    expect((await app.request("/api/auth/login", json("POST", { email: "jan@budowa.pl", password: PASSWORD }))).status).toBe(429);
  });

  it("logs out by revoking the session", async () => {
    const auth = await login("jan@budowa.pl");

    expect((await app.request("/api/auth/logout", { method: "POST", headers: auth })).status).toBe(204);
    expect((await app.request("/api/auth/me", { headers: auth })).status).toBe(401);
  });

  it("does not accept an expired session", async () => {
    const auth = await login("jan@budowa.pl");
    await sql`update sessions set expires_at = now() - interval '1 second'`;

    expect((await app.request("/api/auth/me", { headers: auth })).status).toBe(401);
  });

  it("changes the password and logs out other devices but not this one", async () => {
    const phone = await login("jan@budowa.pl");
    const tablet = await login("jan@budowa.pl");

    const wrong = await app.request("/api/auth/password", json("POST", { currentPassword: "zle", newPassword: "nowe-haslo-456" }, phone));
    expect(wrong.status).toBe(400);
    const tooShort = await app.request("/api/auth/password", json("POST", { currentPassword: PASSWORD, newPassword: "krotkie" }, phone));
    expect(tooShort.status).toBe(400);

    const response = await app.request("/api/auth/password", json("POST", { currentPassword: PASSWORD, newPassword: "nowe-haslo-456" }, phone));
    expect(response.status).toBe(204);
    expect((await app.request("/api/auth/me", { headers: phone })).status).toBe(200);
    expect((await app.request("/api/auth/me", { headers: tablet })).status).toBe(401);
    expect((await app.request("/api/auth/login", json("POST", { email: "jan@budowa.pl", password: "nowe-haslo-456" }))).status).toBe(200);
  });
});

describe("shared tokens from env", () => {
  it("keep ADMIN_TOKEN as emergency admin access with no user", async () => {
    const me = await app.request("/api/auth/me", { headers: ADMIN });
    expect(await me.json()).toEqual({ role: "admin", user: null });
  });

  it("keep the legacy APP_TOKEN working for every project until it is switched off", async () => {
    expect((await app.request(`/api/projects/${other}/documents`, { headers: APP })).status).toBe(200);

    config.appToken = "";
    expect(await principalFromToken("")).toBeNull();
    expect((await app.request("/api/projects", { headers: APP })).status).toBe(401);
  });
});

describe("user management", () => {
  it("lets the emergency admin create the first owner, who then manages contractors", async () => {
    const created = await app.request("/api/users", json("POST", { email: "Pawel@Firma.pl", name: "Paweł", password: PASSWORD, role: "owner" }, ADMIN));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ email: "pawel@firma.pl", name: "Paweł", role: "owner", disabled: false });

    const owner = await login("pawel@firma.pl");
    expect(await (await app.request("/api/auth/me", { headers: owner })).json()).toMatchObject({ role: "admin" });

    const contractor = await app.request("/api/users", json("POST", { email: "ola@budowa.pl", password: PASSWORD, role: "contractor" }, owner));
    expect(contractor.status).toBe(201);
    const { id } = (await contractor.json()) as { id: string };
    expect((await app.request(`/api/projects/${other}/members/${id}`, { method: "PUT", headers: owner })).status).toBe(204);

    const list = (await (await app.request("/api/users", { headers: owner })).json()) as { email: string; projectIds: string[] }[];
    expect(list.find((user) => user.email === "ola@budowa.pl")?.projectIds).toEqual([other]);
    const members = await app.request(`/api/projects/${other}/members`, { headers: owner });
    expect(await members.json()).toEqual([expect.objectContaining({ id, email: "ola@budowa.pl" })]);
  });

  it("validates new accounts", async () => {
    const create = (body: unknown) => app.request("/api/users", json("POST", body, ADMIN));

    expect((await create({ email: "zly-email", password: PASSWORD, role: "contractor" })).status).toBe(400);
    expect((await create({ email: "a@b.pl", password: "krotkie", role: "contractor" })).status).toBe(400);
    expect((await create({ email: "a@b.pl", password: PASSWORD, role: "szef" })).status).toBe(400);
    expect((await create({ email: "JAN@budowa.pl", password: PASSWORD, role: "contractor" })).status).toBe(409);
  });

  it("keeps user management away from contractors and the app token", async () => {
    const contractor = await login("jan@budowa.pl");

    expect((await app.request("/api/users", { headers: contractor })).status).toBe(401);
    expect((await app.request("/api/users", { headers: APP })).status).toBe(401);
    expect((await app.request(`/api/projects/${other}/members/${contractorId}`, { method: "PUT", headers: contractor })).status).toBe(401);
  });

  it("disabling an account ends its sessions", async () => {
    const contractor = await login("jan@budowa.pl");

    const response = await app.request(`/api/users/${contractorId}`, json("PATCH", { disabled: true }, ADMIN));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ disabled: true });
    expect((await app.request("/api/auth/me", { headers: contractor })).status).toBe(401);
    expect(await sql`select 1 from sessions`).toHaveLength(0);
  });

  it("does not let an owner lock themselves out", async () => {
    const ownerId = await createUser("pawel@firma.pl", "owner");
    const owner = await login("pawel@firma.pl");

    expect((await app.request(`/api/users/${ownerId}`, json("PATCH", { disabled: true }, owner))).status).toBe(400);
    expect((await app.request(`/api/users/${ownerId}`, json("PATCH", { role: "contractor" }, owner))).status).toBe(400);
    expect((await app.request(`/api/users/${ownerId}`, { method: "DELETE", headers: owner })).status).toBe(400);
  });

  it("removes a contractor from a project", async () => {
    const contractor = await login("jan@budowa.pl");

    expect((await app.request(`/api/projects/${assigned}/members/${contractorId}`, { method: "DELETE", headers: ADMIN })).status).toBe(204);
    expect((await app.request(`/api/projects/${assigned}/documents`, { headers: contractor })).status).toBe(404);
  });

  it("returns 404 for unknown or malformed user ids", async () => {
    expect((await app.request("/api/users/nie-uuid", json("PATCH", { name: "X" }, ADMIN))).status).toBe(404);
    expect((await app.request(`/api/projects/${assigned}/members/nie-uuid`, { method: "PUT", headers: ADMIN })).status).toBe(404);
  });
});

describe("contractor access", () => {
  it("lists only assigned projects", async () => {
    const contractor = await login("jan@budowa.pl");

    const response = await app.request("/api/projects", { headers: contractor });

    expect(await response.json()).toEqual([expect.objectContaining({ id: assigned, name: "Hala sportowa" })]);
    expect(((await (await app.request("/api/projects", { headers: ADMIN })).json()) as unknown[]).length).toBe(2);
  });

  it("reads documents and pages of an assigned project but not of another one", async () => {
    const contractor = await login("jan@budowa.pl");
    const mine = await createDocument(assigned, "ready");
    const theirs = await createDocument(other, "ready");

    expect((await app.request(`/api/projects/${assigned}/documents`, { headers: contractor })).status).toBe(200);
    expect((await app.request(`/api/documents/${mine}`, { headers: contractor })).status).toBe(200);
    expect((await app.request(`/api/documents/${mine}/pages`, { headers: contractor })).status).toBe(200);

    for (const path of [`/api/projects/${other}/documents`, `/api/documents/${theirs}`, `/api/documents/${theirs}/pages`, `/api/documents/${theirs}/pages/1/text`]) {
      const response = await app.request(path, { headers: contractor });
      expect(response.status, path).toBe(404);
    }
  });

  it("serves page images only from assigned projects, also with ?token=", async () => {
    const contractor = await login("jan@budowa.pl");
    const token = contractor.authorization.slice("Bearer ".length);
    const mine = await createDocument(assigned, "ready");
    const theirs = await createDocument(other, "ready");
    for (const doc of [mine, theirs]) {
      await mkdir(documentDir(doc), { recursive: true });
      await writeFile(pageImage(doc, 1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }

    expect((await app.request(`/api/documents/${mine}/pages/1/image?token=${token}`)).status).toBe(200);
    expect((await app.request(`/api/documents/${theirs}/pages/1/image?token=${token}`)).status).toBe(404);
    expect((await app.request(`/api/documents/${theirs}/pages/1/image`, { headers: contractor })).status).toBe(404);
  });

  it("cannot reach the admin endpoints", async () => {
    const contractor = await login("jan@budowa.pl");

    const upload = await app.request(`/api/projects/${assigned}/documents?filename=a.pdf`, { method: "PUT", body: makePdf(["x"]), headers: contractor });
    expect(upload.status).toBe(401);
    expect((await app.request("/api/admin/copilotkit/info", { method: "POST", headers: contractor })).status).toBe(401);
  });
});

describe("agent factory", () => {
  const agentRequest = (headers: Record<string, string>) => new Request("http://localhost/api/copilotkit/agent/default/run", { headers });

  it("builds the agent for an assigned project", async () => {
    const contractor = await login("jan@budowa.pl");

    await expect(agentProjectId(agentRequest({ ...contractor, "x-project-id": assigned }), ["app", "admin"])).resolves.toBe(assigned);
  });

  it("refuses a project the contractor is not a member of, even with a valid session", async () => {
    const contractor = await login("jan@budowa.pl");

    await expect(agentProjectId(agentRequest({ ...contractor, "x-project-id": other }), ["app", "admin"])).rejects.toThrow("Nieznany projekt");
  });

  it("refuses a missing or wrong token and a role outside the endpoint", async () => {
    const contractor = await login("jan@budowa.pl");

    await expect(agentProjectId(agentRequest({ "x-project-id": assigned }), ["app", "admin"])).rejects.toThrow("Brak dostępu");
    await expect(agentProjectId(agentRequest({ ...contractor, "x-project-id": assigned }), ["admin"])).rejects.toThrow("Brak dostępu");
    await expect(agentProjectId(agentRequest({ ...ADMIN, "x-project-id": other }), ["admin"])).resolves.toBe(other);
  });

  it("does not run the agent over HTTP for another project", async () => {
    const contractor = await login("jan@budowa.pl");

    const response = await app.request("/api/copilotkit/agent/default/run", {
      method: "POST",
      headers: { ...contractor, "x-project-id": other, "content-type": "application/json" },
      body: JSON.stringify({ threadId: "t1", runId: "r1", messages: [], tools: [], context: [], state: {}, forwardedProps: {} }),
    });

    expect(response.ok).toBe(false);
    expect(await response.json()).toMatchObject({ message: "Nieznany projekt" });
  });
});

describe("rate limits", () => {
  it("limits agent runs per user but not the runtime's info calls", async () => {
    config.chatRequestsPerMinute = 2;
    const contractor = await login("jan@budowa.pl");
    const run = () =>
      app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { ...contractor, "x-project-id": other, "content-type": "application/json" },
        body: "{}",
      });

    expect((await run()).status).not.toBe(429);
    expect((await run()).status).not.toBe(429);
    const blocked = await run();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await app.request("/api/copilotkit/info", { method: "POST", headers: contractor })).status).not.toBe(429);
    // Another user has their own budget.
    await createUser("ola@budowa.pl", "contractor");
    const ola = await login("ola@budowa.pl");
    expect((await app.request("/api/copilotkit/agent/default/run", { method: "POST", headers: ola, body: "{}" })).status).not.toBe(429);
  });

  it("limits uploads per user", async () => {
    config.uploadsPerHour = 1;
    const upload = () =>
      app.request(`/api/projects/${assigned}/documents?filename=a.pdf`, { method: "PUT", body: makePdf(["x"]), headers: ADMIN });

    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(429);
  });
});

describe("offline search index", () => {
  it("gives a contractor the page text of their own project and hides other projects", async () => {
    const documentId = await createDocument(assigned, "ready");
    await sql`
      insert into pages (document_id, project_id, page_no, title, summary, keywords, raw_text, indexed)
      values (${documentId}, ${assigned}, 2, 'Rzut dachu', 'Dach hali', ${["dach", "A-04"]}, 'Rys. A-04 rzut dachu', true),
        (${documentId}, ${assigned}, 3, null, null, '{}', '', false)`;
    const otherDocument = await createDocument(other, "ready");
    await sql`
      insert into pages (document_id, project_id, page_no, raw_text, indexed)
      values (${otherDocument}, ${other}, 1, 'Szkoła', true)`;
    const auth = await login("jan@budowa.pl");

    const response = await app.request(`/api/projects/${assigned}/search-index`, { headers: auth });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { generatedAt: string; pages: unknown[] };
    expect(body.pages).toEqual([
      {
        documentId,
        filename: "projekt.pdf",
        pageNo: 2,
        title: "Rzut dachu",
        kind: null,
        summary: "Dach hali",
        keywords: ["dach", "A-04"],
        text: "Rys. A-04 rzut dachu",
      },
    ]);
    expect((await app.request(`/api/projects/${other}/search-index`, { headers: auth })).status).toBe(404);
  });
});
