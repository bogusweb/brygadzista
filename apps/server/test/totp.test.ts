import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { base32Decode, base32Encode, totpCode, totpCounter } from "../src/totp.js";
import { createUser, login, PASSWORD, resetDatabase } from "./helpers.js";

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const EMAIL = "jan@budowa.pl";

// Turns the second factor on and returns the secret and the recovery codes.
const enable = async (headers: Record<string, string>) => {
  const setup = (await (await app.request("/api/auth/totp/setup", json("POST", { password: PASSWORD }, headers))).json()) as {
    secret: string;
    uri: string;
  };
  const response = await app.request("/api/auth/totp/enable", json("POST", { code: totpCode(setup.secret) }, headers));
  expect(response.status).toBe(200);
  const { recoveryCodes } = (await response.json()) as { recoveryCodes: string[] };
  return { ...setup, recoveryCodes };
};

// A code from the next time step, as the phone would show it 30 seconds later (a code is valid once).
const nextCode = (secret: string) => totpCode(secret, Date.now() + 30_000);

describe("TOTP codes (RFC 6238)", () => {
  it("match the RFC test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(totpCode(secret, 1_111_111_109_000)).toBe("081804");
  });

  it("accept one step of clock drift and nothing more", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = 1_111_111_109_000;
    expect(totpCounter(secret, totpCode(secret, now - 30_000), now)).not.toBeNull();
    expect(totpCounter(secret, totpCode(secret, now - 90_000), now)).toBeNull();
  });
});

describe("second factor at login (#176)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await createUser(EMAIL, "owner");
  });

  afterAll(async () => {
    await sql.end();
  });

  it("is off until a code from the app confirms the secret", async () => {
    const headers = await login(EMAIL);
    const setup = await app.request("/api/auth/totp/setup", json("POST", { password: PASSWORD }, headers));
    const { secret, uri } = (await setup.json()) as { secret: string; uri: string };
    expect(uri).toContain(`secret=${secret}`);
    expect(((await (await app.request("/api/auth/totp", { headers })).json()) as { enabled: boolean }).enabled).toBe(false);
    expect((await app.request("/api/auth/totp/enable", json("POST", { code: "000000" }, headers))).status).toBe(400);
    // Still a plain password login.
    expect((await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD }))).status).toBe(200);
  });

  it("needs the password to start", async () => {
    const headers = await login(EMAIL);
    expect((await app.request("/api/auth/totp/setup", json("POST", { password: "zle-haslo-123" }, headers))).status).toBe(401);
  });

  it("asks for the code once it is on, and takes each code only once", async () => {
    const { secret } = await enable(await login(EMAIL));
    const withoutCode = await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD }));
    expect(withoutCode.status).toBe(401);
    expect(await withoutCode.json()).toMatchObject({ totpRequired: true });
    expect((await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD, code: "123456" }))).status).toBe(401);

    const code = nextCode(secret);
    const ok = await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD, code }));
    expect(ok.status).toBe(200);
    const replay = await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD, code }));
    expect(replay.status).toBe(401);
  });

  it("does not ask for the code before the password is right", async () => {
    await enable(await login(EMAIL));
    const response = await app.request("/api/auth/login", json("POST", { email: EMAIL, password: "zle-haslo-123" }));
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("totpRequired");
  });

  it("lets a recovery code in once, and stores only hashes", async () => {
    const { recoveryCodes } = await enable(await login(EMAIL));
    expect(recoveryCodes).toHaveLength(10);
    const code = recoveryCodes[0]!;
    expect((await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD, code }))).status).toBe(200);
    expect((await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD, code }))).status).toBe(401);
    const [row] = await sql<{ recovery: string[] }[]>`select totp_recovery as recovery from users where email = ${EMAIL}`;
    expect(row!.recovery).toHaveLength(9);
    expect(row!.recovery.join()).not.toContain(code.replace(/-/g, ""));
  });

  it("is turned off only with the password and a code", async () => {
    const headers = await login(EMAIL);
    const { secret } = await enable(headers);
    expect((await app.request("/api/auth/totp/disable", json("POST", { password: PASSWORD }, headers))).status).toBe(400);
    expect((await app.request("/api/auth/totp/disable", json("POST", { password: "zle", code: nextCode(secret) }, headers))).status).toBe(401);
    const off = await app.request("/api/auth/totp/disable", json("POST", { password: PASSWORD, code: nextCode(secret) }, headers));
    expect(off.status).toBe(200);
    expect((await app.request("/api/auth/login", json("POST", { email: EMAIL, password: PASSWORD }))).status).toBe(200);
  });

  it("keeps the secret away from the firm's database role", async () => {
    const [grant] = await sql<{ count: number }[]>`
      select count(*)::int as count from information_schema.column_privileges
      where table_name = 'users' and column_name like 'totp%' and grantee = 'brygadzista_tenant'`;
    expect(grant!.count).toBe(0);
  });
});
