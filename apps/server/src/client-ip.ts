import { config } from "./config.js";

// The address that limits login attempts (#164). Cloudflare sets CF-Connecting-IP and overwrites one the client sends;
// the first entry of X-Forwarded-For is whatever the client wrote, so without Cloudflare the entry added by the last
// trusted proxy counts (TRUSTED_PROXIES from the end, Openship's proxy by default).
export const clientIp = (request: Request) => {
  const cloudflare = config.clientIpHeader ? request.headers.get(config.clientIpHeader)?.trim() : "";
  if (cloudflare) return cloudflare;
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-Math.max(1, config.trustedProxies)) ?? hops[0] ?? "unknown";
};
