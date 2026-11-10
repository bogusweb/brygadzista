import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { authorize, bearerToken, principalFromSessionHash, principalFromToken, requireRole, sessionTokenHash, type AuthEnv, type Principal, type Role } from "./auth.js";
import { config } from "./config.js";

// Files opened outside fetch (#165): <img> in the browser, a PDF opened in the phone's browser. Before, their URLs
// carried the login session, so a forwarded link or a proxy log handed over the whole account. Now:
// - the dashboard and the web app get a short-lived cookie (bf) that opens files only, set from a request with the
//   session in the header;
// - a PDF opened in another app gets a link signed for that one path, valid for minutes.
// Both name the session by its hash, so they stop working when the person logs out or the session ends.

export const FILE_COOKIE = "bf";
const FILE_COOKIE_SECONDS = 2 * 60 * 60;
const FILE_LINK_SECONDS = 10 * 60;
const ADMIN_SUBJECT = "admin";
// The legacy shared APP_TOKEN, which works only outside production.
const APP_SUBJECT = "app";

type Grant = { h: string; e: number; p?: string };

let cachedSecret: Buffer | undefined;

// FILE_LINK_SECRET, or a random key kept next to the data so links survive a restart.
const secret = () => {
  if (cachedSecret) return cachedSecret;
  if (config.fileLinkSecret) return (cachedSecret = Buffer.from(config.fileLinkSecret));
  const file = path.join(config.dataDir, ".file-link-key");
  try {
    cachedSecret = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
  } catch {
    cachedSecret = randomBytes(32);
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file, cachedSecret.toString("base64url"), { mode: 0o600 });
  }
  return cachedSecret;
};

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

const encode = (grant: Grant) => {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${sign(payload)}`;
};

const decode = (value: string | undefined): Grant | null => {
  if (!value || value.length > 2048) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString()) as Grant;
    return typeof grant.h === "string" && typeof grant.e === "number" && grant.e > Date.now() / 1000 ? grant : null;
  } catch {
    return null;
  }
};

// The session a request came with, as the hash a grant names.
const subjectOf = (request: Request) => {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return null;
  if (config.adminToken && token === config.adminToken) return ADMIN_SUBJECT;
  if (config.appToken && token === config.appToken) return APP_SUBJECT;
  return token.startsWith("bs_") ? sessionTokenHash(token) : null;
};

const principalOf = async (grant: Grant, request: Request): Promise<Principal | null> => {
  if (grant.h === ADMIN_SUBJECT) return config.adminToken ? principalFromToken(config.adminToken, request) : null;
  if (grant.h === APP_SUBJECT) return config.appToken ? principalFromToken(config.appToken, request) : null;
  return principalFromSessionHash(grant.h);
};

// The path a link was signed for: the URL without its own link parameter.
const signedPath = (url: URL) => {
  const query = new URLSearchParams(url.search);
  query.delete("link");
  const rest = query.toString();
  return `${url.pathname}${rest ? `?${rest}` : ""}`;
};

export const principalFromFileAccess = async (request: Request): Promise<Principal | null> => {
  const url = new URL(request.url);
  const link = decode(url.searchParams.get("link") ?? undefined);
  if (link) return link.p === signedPath(url) ? principalOf(link, request) : null;
  const cookie = decode(getCookieFrom(request));
  return cookie && cookie.p === undefined ? principalOf(cookie, request) : null;
};

const getCookieFrom = (request: Request) => {
  const header = request.headers.get("cookie") ?? "";
  const match = header.split(/;\s*/).find((part) => part.startsWith(`${FILE_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(FILE_COOKIE.length + 1)) : undefined;
};

// Since #165 the query carries a short-lived file link (?link=, one path) or the browser sends the file cookie (bf);
// the login session itself never goes into a URL.
export const requireRoleOrQueryToken = (...allowed: Role[]): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const header = bearerToken(c.req.header("authorization"));
  if (header) return authorize(allowed, header)(c, next);
  const principal = await principalFromFileAccess(c.req.raw);
  if (!principal || !allowed.includes(principal.role)) return c.json({ error: "Brak dostępu" }, 401);
  c.set("principal", principal);
  await next();
};

// Paths a link may be made for: the routes that serve files.
const FILE_ROUTES = [
  /^\/api\/documents\/[\w-]+\/pages\/\d+\/(image|crop)$/,
  /^\/api\/projects\/[\w-]+\/photos\/[\w-]+\/image$/,
  /^\/api\/projects\/[\w-]+\/defects\/protocol\.pdf$/,
  /^\/api\/projects\/[\w-]+\/diary\/report\.pdf$/,
  /^\/api\/reports\/[\w-]+\/report\.pdf$/,
  /^\/api\/protocols\/[\w-]+\/protocol\.pdf$/,
];

export const fileAccess = new Hono<AuthEnv>();

// The cookie for <img> in the dashboard and the web app. Strict, so another site cannot make the browser send it.
fileAccess.post("/api/auth/file-cookie", requireRole("admin", "app"), (c) => {
  const subject = subjectOf(c.req.raw);
  if (!subject) return c.json({ error: "Brak sesji" }, 400);
  const expiresAt = Math.floor(Date.now() / 1000) + FILE_COOKIE_SECONDS;
  setCookie(c, FILE_COOKIE, encode({ h: subject, e: expiresAt }), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:" || process.env.NODE_ENV === "production",
    sameSite: "Strict",
    path: "/api",
    maxAge: FILE_COOKIE_SECONDS,
  });
  return c.json({ expiresAt: new Date(expiresAt * 1000) });
});

// A link to one file for a few minutes, e.g. a PDF the phone opens in its browser.
fileAccess.post("/api/file-links", requireRole("admin", "app"), async (c) => {
  const body = await c.req.json<{ path?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const subject = subjectOf(c.req.raw);
  if (!subject || typeof body.path !== "string") return c.json({ error: "Podaj ścieżkę pliku" }, 400);
  const url = new URL(body.path, "http://local");
  if (url.host !== "local" || !FILE_ROUTES.some((route) => route.test(url.pathname))) return c.json({ error: "To nie jest plik" }, 400);
  const expiresAt = Math.floor(Date.now() / 1000) + FILE_LINK_SECONDS;
  const target = signedPath(url);
  const link = encode({ h: subject, e: expiresAt, p: target });
  return c.json({ path: `${target}${target.includes("?") ? "&" : "?"}link=${encodeURIComponent(link)}`, expiresAt: new Date(expiresAt * 1000) });
});

