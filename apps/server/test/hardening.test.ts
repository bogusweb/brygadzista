import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { resetDatabase } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await sql.end();
});

describe("request size (#170)", () => {
  it("refuses a huge body on login before reading it whole", async () => {
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.pl", password: "x".repeat(6 * 1024 * 1024) }),
    });

    expect(response.status).toBe(413);
  });

  it("refuses a password longer than any real one", async () => {
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.pl", password: "x".repeat(10_000) }),
    });

    expect(response.status).toBe(401);
  });

  it("keeps the counters of client-chosen keys under a ceiling", () => {
    const limiter = createRateLimiter(() => 5, 60_000);
    for (let i = 0; i < 60_000; i++) limiter.hit(`klucz-${i}`);

    expect(limiter.size()).toBeLessThanOrEqual(50_000);
  });
});

describe("security headers and CORS (#171)", () => {
  it("sends a CSP that keeps scripts, requests and images on this server", async () => {
    const response = await app.request("/api/health");
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("gives no CORS access to other sites", async () => {
    const response = await app.request("/api/projects", { method: "OPTIONS", headers: { origin: "https://zly.example", "access-control-request-method": "GET" } });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows the development servers outside production", async () => {
    const response = await app.request("/api/health", { headers: { origin: "http://localhost:8081" } });

    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
  });
});

describe("small fixes (#177)", () => {
  it("tells nobody outside how the server is set up", async () => {
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true });
    const { ADMIN } = await import("./helpers.js");
    expect(await (await app.request("/api/operator/status", { headers: ADMIN })).json()).toMatchObject({ llm: false });
  });

  it("starts CSV cells that look like formulas with an apostrophe", async () => {
    const { scheduleCsv } = await import("../src/schedules.js");
    const csv = scheduleCsv([
      { category: "stal", element: "=HYPERLINK(\"http://zly.example\")", level: "", mark: "+1", description: "@SUM(A1)", dimensions: "",
        quantity: -3, unit: "kg", documentId: "d", pageNo: 1, note: "" } as never,
    ]);

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain("-3");
  });
});

describe("operator token and reads (#168)", () => {
  it("lets ADMIN_TOKEN work only from ADMIN_TOKEN_IPS when they are set", async () => {
    const { config } = await import("../src/config.js");
    const { ADMIN } = await import("./helpers.js");
    config.adminTokenIps = ["203.0.113.5"];
    try {
      expect((await app.request("/api/projects", { headers: { ...ADMIN, "cf-connecting-ip": "198.51.100.1" } })).status).toBe(401);
      expect((await app.request("/api/projects", { headers: { ...ADMIN, "cf-connecting-ip": "203.0.113.5" } })).status).toBe(200);
    } finally {
      config.adminTokenIps = [];
    }
  });

  it("writes down when an operator reads a firm's project without entering the firm", async () => {
    const { ADMIN, createProject, createTenant } = await import("./helpers.js");
    const { forgetOperatorReads } = await import("../src/auth.js");
    forgetOperatorReads();
    const firm = await createTenant("Firma czytana");
    const project = await createProject("Dom", firm);

    await app.request(`/api/projects/${project}/documents`, { headers: ADMIN });
    await app.request(`/api/projects/${project}/documents`, { headers: ADMIN });

    const rows = await sql`select tenant_name, action, operator_name from operator_audit where tenant_id = ${firm}`;
    expect(rows).toEqual([{ tenant_name: "Firma czytana", action: "read", operator_name: "ADMIN_TOKEN" }]);
  });
});

describe("sessions (#167)", () => {
  it("lists the account's sessions and ends one or all the others", async () => {
    const { createUser, login, createTenant } = await import("./helpers.js");
    await createUser("jan@budowa.pl", "worker", undefined, await createTenant());
    const phone = await login("jan@budowa.pl");
    const laptop = await login("jan@budowa.pl");
    const tablet = await login("jan@budowa.pl");

    const listed = (await (await app.request("/api/auth/sessions", { headers: laptop })).json()) as { id: string; current: boolean }[];
    expect(listed).toHaveLength(3);
    expect(listed.filter((session) => session.current)).toHaveLength(1);

    const phoneId = ((await (await app.request("/api/auth/sessions", { headers: phone })).json()) as { id: string; current: boolean }[])
      .find((session) => session.current)!.id;
    expect((await app.request(`/api/auth/sessions/${phoneId}`, { method: "DELETE", headers: laptop })).status).toBe(204);
    expect((await app.request("/api/auth/me", { headers: phone })).status).toBe(401);

    expect((await app.request("/api/auth/sessions/end-others", { method: "POST", headers: laptop })).status).toBe(204);
    expect((await app.request("/api/auth/me", { headers: tablet })).status).toBe(401);
    expect((await app.request("/api/auth/me", { headers: laptop })).status).toBe(200);
  });

  it("ends a session at its maximum lifetime however often it is used", async () => {
    const { createUser, login, createTenant } = await import("./helpers.js");
    await createUser("jan@budowa.pl", "worker", undefined, await createTenant());
    const auth = await login("jan@budowa.pl");
    expect((await app.request("/api/auth/me", { headers: auth })).status).toBe(200);

    await sql`update sessions set created_at = now() - interval '91 days', expires_at = now() + interval '20 days'`;

    expect((await app.request("/api/auth/me", { headers: auth })).status).toBe(401);
  });

  it("keeps an operator's session for a week at most", async () => {
    const { createOperator, login } = await import("./helpers.js");
    await createOperator("operator@serwis.pl");
    const auth = await login("operator@serwis.pl");
    await sql`update sessions set created_at = now() - interval '8 days'`;

    expect((await app.request("/api/auth/me", { headers: auth })).status).toBe(401);
  });
});

describe("file access without the session in URLs (#165)", () => {
  it("opens files with the file cookie, and stops when the session ends", async () => {
    const { createUser, login, createTenant, createProject, createDocument } = await import("./helpers.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { documentDir, pageImage } = await import("../src/storage.js");
    const firm = await createTenant();
    await createUser("szef@a.pl", "owner", undefined, firm);
    const auth = await login("szef@a.pl");
    const documentId = await createDocument(await createProject("Dom", firm), "ready");
    await mkdir(await documentDir(documentId), { recursive: true });
    await writeFile(await pageImage(documentId, 1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const image = `/api/documents/${documentId}/pages/1/image`;

    const issued = await app.request("/api/auth/file-cookie", { method: "POST", headers: auth });
    const setCookie = issued.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^bf=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0]!;

    expect((await app.request(image, { headers: { cookie } })).status).toBe(200);
    expect((await app.request(`/api/projects`, { headers: { cookie } })).status).toBe(401);

    await app.request("/api/auth/logout", { method: "POST", headers: auth });
    expect((await app.request(image, { headers: { cookie } })).status).toBe(401);
  });

  it("makes links only for file routes", async () => {
    const { ADMIN } = await import("./helpers.js");
    const response = await app.request("/api/file-links", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ path: "/api/projects" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("the firm's database role (#172)", () => {
  it("cannot read credentials even when a query inside a firm goes wrong", async () => {
    const { createTenant } = await import("./helpers.js");
    const { withTenant } = await import("../src/db.js");
    const firm = await createTenant();

    const attempt = (query: string) => withTenant(firm, (tx) => tx.unsafe(query)).then(() => "read", () => "refused");

    expect(await attempt("select password_hash from users")).toBe("refused");
    expect(await attempt("select totp_secret from users")).toBe("refused");
    expect(await attempt("select token_hash from sessions")).toBe("refused");
    expect(await attempt("select token_hash from mcp_tokens")).toBe("refused");
    expect(await attempt("select token_hash from tenant_invites")).toBe("refused");
    expect(await attempt("select id, name, email from users")).toBe("read");
  });
});
