import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { sessionTokenHash } from "./auth.js";
import { config } from "./config.js";
import { sql } from "./db.js";

// Read-only links to one thing on a project (#84 weekly report, #82 protocol), on top of the share links from #88:
// only a hash of the token is stored, the link is bound to the project and its firm, and it expires.

export type ShareTarget = { type: "report" | "protocol"; id: string };

export const SHARE_LINK_DAYS = 30;
export const MAX_SHARE_LINK_DAYS = 90;

export const shareDays = (value: unknown) =>
  typeof value === "number" && value >= 1 && value <= MAX_SHARE_LINK_DAYS ? Math.floor(value) : SHARE_LINK_DAYS;

export const createShareLink = async (projectId: string, target: ShareTarget, createdBy: string | null, days = SHARE_LINK_DAYS) => {
  const token = `bl_${randomBytes(24).toString("base64url")}`;
  const [link] = await sql<{ expiresAt: Date }[]>`
    insert into share_links (token_hash, project_id, created_by, expires_at, target_type, target_id)
    values (${sessionTokenHash(token)}, ${projectId}, ${createdBy}, now() + make_interval(days => ${days}), ${target.type}, ${target.id})
    returning expires_at as "expiresAt"`;
  return { token, expiresAt: link!.expiresAt };
};

// The link's target, when the token is known, not expired, and its firm is active; null otherwise.
export const resolveShareLink = async (token: string, type: ShareTarget["type"]) => {
  if (!/^bl_[\w-]{20,64}$/.test(token)) return null;
  const [link] = await sql<{ projectId: string; targetId: string; expiresAt: Date }[]>`
    select l.project_id as "projectId", l.target_id as "targetId", l.expires_at as "expiresAt" from share_links l
    join projects p on p.id = l.project_id and p.tenant_id = l.tenant_id
    join tenants t on t.id = l.tenant_id and t.disabled_at is null
    where l.token_hash = ${sessionTokenHash(token)} and l.expires_at > now() and l.target_type = ${type}`;
  return link ?? null;
};

export const publicOrigin = (c: Context) => {
  if (config.publicUrl) return config.publicUrl;
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  return `${proto}://${host}`;
};

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

// The read-only pages are plain HTML from the server: they open on any phone, with no app and no login.
export const publicPage = (title: string, body: string) => `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --text: #1d2125; --muted: #5f6b76; --border: #dfe3e8; --bg: #f6f7f9; --surface: #fff; --accent: #1f4e79; }
@media (prefers-color-scheme: dark) { :root { --text: #e8eaed; --muted: #a0a8b0; --border: #33383d; --bg: #15181b; --surface: #1d2125; --accent: #8cb8e8; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; } h2 { font-size: 1.15rem; margin: 28px 0 8px; } h3 { font-size: 1rem; margin: 16px 0 4px; }
p, li { margin: 4px 0; } ul { padding-left: 20px; }
.muted { color: var(--muted); font-size: 0.875rem; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 12px 0; }
.src { color: var(--accent); font-size: 0.8rem; white-space: nowrap; }
.status-open { color: #c0392b; } .status-to_check { color: #b7791f; } .status-closed { color: #2f7d4a; }
.photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.photos figure { margin: 0; } .photos img { width: 100%; border-radius: 6px; display: block; } .photos figcaption { font-size: 0.75rem; color: var(--muted); }
a.button { display: inline-block; padding: 10px 16px; border-radius: 8px; background: var(--accent); color: var(--surface); text-decoration: none; font-weight: 600; }
img.signature { max-width: 260px; height: auto; background: #fff; border-radius: 6px; }
</style></head><body><main>${body}</main></body></html>`;

export const notFoundPage = () => publicPage("Link nieaktywny", "<h1>Link wygasł albo nie istnieje</h1><p class=\"muted\">Poproś wykonawcę o nowy link.</p>");
