import type { MiddlewareHandler } from "hono";
import type { AuthEnv, Principal } from "./auth.js";
import { config } from "./config.js";

// Fixed-window counters in memory. The server runs as a single process on ruth154, so this is enough;
// several instances would need the counters in Postgres or Redis.
export const createRateLimiter = (limit: () => number, windowMs: number) => {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    // Counts one attempt for `key`; returns the seconds to wait when the limit is used up.
    hit(key: string, now = Date.now()): number | null {
      if (windows.size > 10_000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      let window = windows.get(key);
      if (!window || window.resetAt <= now) windows.set(key, (window = { count: 0, resetAt: now + windowMs }));
      if (window.count >= limit()) return Math.ceil((window.resetAt - now) / 1000);
      window.count++;
      return null;
    },
    forget(key: string) {
      windows.delete(key);
    },
    reset() {
      windows.clear();
    },
  };
};

export type RateLimiter = ReturnType<typeof createRateLimiter>;

export const limiters = {
  chat: createRateLimiter(() => config.chatRequestsPerMinute, 60_000),
  chatTenant: createRateLimiter(() => config.chatRequestsPerMinutePerTenant, 60_000),
  mcp: createRateLimiter(() => config.mcpCallsPerMinute, 60_000),
  upload: createRateLimiter(() => config.uploadsPerHour, 60 * 60_000),
  diary: createRateLimiter(() => config.diaryNotesPerHour, 60 * 60_000),
  loginEmail: createRateLimiter(() => config.loginAttemptsPer15Min, 15 * 60_000),
  // One address may try several accounts (an office behind one IP), so it gets more room.
  loginIp: createRateLimiter(() => config.loginAttemptsPer15Min * 5, 15 * 60_000),
};

export const principalKey = (principal: Principal) => (principal.user ? `user:${principal.user.id}` : `token:${principal.role}`);

export const tooManyRequests = (retryAfterSeconds: number) =>
  new Response(JSON.stringify({ error: `Za dużo żądań, spróbuj za ${retryAfterSeconds} s` }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(retryAfterSeconds) },
  });

// Run after requireRole. `applies` picks which requests count, e.g. only agent runs on the CopilotKit endpoint.
export const rateLimit =
  (limiter: RateLimiter, applies: (request: Request) => boolean = () => true): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    if (applies(c.req.raw)) {
      const retryAfter = limiter.hit(principalKey(c.get("principal")));
      if (retryAfter !== null) return tooManyRequests(retryAfter);
    }
    await next();
  };
