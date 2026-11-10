import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import QRCode from "qrcode";
import { requireRole, verifyPassword, type AuthEnv } from "./auth.js";
import { sql } from "./db.js";
import { limiters, tooManyRequests } from "./rate-limit.js";

// Second factor at login (#176): time-based one-time codes (RFC 6238, the ones Google Authenticator, Aegis or 1Password
// show), 6 digits every 30 seconds, plus ten one-time recovery codes for a lost phone. Only their hashes are kept.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
const RECOVERY_CODES = 10;
const ISSUER = "Brygadzista";

export const base32Encode = (bytes: Buffer) => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (text: string) => {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Nieprawidłowy sekret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

const counterAt = (timeMs: number) => Math.floor(timeMs / 1000 / STEP_SECONDS);

export const totpCode = (secret: string, timeMs = Date.now(), counter = counterAt(timeMs)) => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, "0");
};

const sameCode = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The counter of the step the code belongs to, one step either side for a phone clock that is a little off.
export const totpCounter = (secret: string, code: string, timeMs = Date.now()) => {
  const now = counterAt(timeMs);
  for (const counter of [now, now - 1, now + 1]) if (sameCode(totpCode(secret, timeMs, counter), code)) return counter;
  return null;
};

const recoveryHash = (code: string) => createHash("sha256").update(code.toUpperCase().replace(/[\s-]/g, "")).digest("hex");

const newRecoveryCodes = () =>
  Array.from({ length: RECOVERY_CODES }, () => {
    const code = base32Encode(randomBytes(8)).slice(0, 12);
    return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
  });

type TotpState = { secret: string | null; enabledAt: Date | null; recovery: string[]; lastCounter: string | null };

const stateOf = async (userId: string) => {
  const [row] = await sql<TotpState[]>`
    select totp_secret as secret, totp_enabled_at as "enabledAt", totp_recovery as recovery,
      totp_last_counter::text as "lastCounter"
    from users where id = ${userId}`;
  return row;
};

export const totpEnabled = async (userId: string) => Boolean((await stateOf(userId))?.enabledAt);

// Checks a code from the app or a recovery code, and spends it: a TOTP code cannot be used twice, a recovery code once.
export const useSecondFactor = async (userId: string, code: string) => {
  const state = await stateOf(userId);
  if (!state?.secret || !state.enabledAt) return false;
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const counter = totpCounter(state.secret, digits);
    if (counter === null) return false;
    const spent = await sql`
      update users set totp_last_counter = ${counter}
      where id = ${userId} and (totp_last_counter is null or totp_last_counter < ${counter}) returning 1`;
    return spent.length > 0;
  }
  const hash = recoveryHash(code);
  const used = await sql`
    update users set totp_recovery = array_remove(totp_recovery, ${hash})
    where id = ${userId} and ${hash} = any(totp_recovery) returning 1`;
  return used.length > 0;
};

export const totp = new Hono<AuthEnv>();

const userOf = (principal: AuthEnv["Variables"]["principal"]) => principal.user;

const passwordOk = async (userId: string, password: unknown) => {
  if (typeof password !== "string") return false;
  const [row] = await sql<{ passwordHash: string }[]>`select password_hash as "passwordHash" from users where id = ${userId}`;
  return verifyPassword(row?.passwordHash, password);
};

totp.get("/api/auth/totp", requireRole("admin", "app"), async (c) => {
  const user = userOf(c.get("principal"));
  if (!user) return c.json({ enabled: false, recoveryCodesLeft: 0 });
  const state = await stateOf(user.id);
  return c.json({ enabled: Boolean(state?.enabledAt), enabledAt: state?.enabledAt ?? null, recoveryCodesLeft: state?.recovery.length ?? 0 });
});

// Step 1: a new secret, shown as a QR code (otpauth URI). It counts only after a code from the app confirms it.
totp.post("/api/auth/totp/setup", requireRole("admin", "app"), async (c) => {
  const user = userOf(c.get("principal"));
  if (!user) return c.json({ error: "Wspólny token nie ma konta" }, 400);
  const body = await c.req.json<{ password?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const retryAfter = limiters.loginEmail.hit(user.email);
  if (retryAfter !== null) return tooManyRequests(retryAfter);
  if (!(await passwordOk(user.id, body.password))) return c.json({ error: "Nieprawidłowe hasło" }, 401);
  if (await totpEnabled(user.id)) return c.json({ error: "Logowanie dwuetapowe jest już włączone" }, 409);
  const secret = base32Encode(randomBytes(20));
  await sql`update users set totp_secret = ${secret}, totp_enabled_at = null, totp_recovery = '{}', totp_last_counter = null
    where id = ${user.id}`;
  const label = encodeURIComponent(`${ISSUER}:${user.email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 220 });
  return c.json({ secret, uri, qrDataUrl });
});

// Step 2: the first code from the app turns it on and gives out the recovery codes, once.
totp.post("/api/auth/totp/enable", requireRole("admin", "app"), async (c) => {
  const user = userOf(c.get("principal"));
  if (!user) return c.json({ error: "Wspólny token nie ma konta" }, 400);
  const body = await c.req.json<{ code?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const state = await stateOf(user.id);
  if (!state?.secret || state.enabledAt) return c.json({ error: "Najpierw rozpocznij konfigurację" }, 409);
  const retryAfter = limiters.loginEmail.hit(user.email);
  if (retryAfter !== null) return tooManyRequests(retryAfter);
  const counter = typeof body.code === "string" ? totpCounter(state.secret, body.code.replace(/\s/g, "")) : null;
  if (counter === null) return c.json({ error: "Nieprawidłowy kod" }, 400);
  const codes = newRecoveryCodes();
  await sql`update users set totp_enabled_at = now(), totp_last_counter = ${counter}, totp_recovery = ${codes.map(recoveryHash)}
    where id = ${user.id}`;
  limiters.loginEmail.forget(user.email);
  return c.json({ enabled: true, recoveryCodes: codes });
});

// Turning it off needs the password and a current code (or a recovery code), so a stolen session alone cannot.
totp.post("/api/auth/totp/disable", requireRole("admin", "app"), async (c) => {
  const user = userOf(c.get("principal"));
  if (!user) return c.json({ error: "Wspólny token nie ma konta" }, 400);
  const body = await c.req.json<{ password?: unknown; code?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const retryAfter = limiters.loginEmail.hit(user.email);
  if (retryAfter !== null) return tooManyRequests(retryAfter);
  if (!(await passwordOk(user.id, body.password))) return c.json({ error: "Nieprawidłowe hasło" }, 401);
  if (typeof body.code !== "string" || !(await useSecondFactor(user.id, body.code))) return c.json({ error: "Nieprawidłowy kod" }, 400);
  await sql`update users set totp_secret = null, totp_enabled_at = null, totp_recovery = '{}', totp_last_counter = null
    where id = ${user.id}`;
  return c.json({ enabled: false });
});
