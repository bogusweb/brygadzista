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
