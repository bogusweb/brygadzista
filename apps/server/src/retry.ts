import { setTimeout as sleep } from "node:timers/promises";

// Error with the HTTP status of a failed model call, so retry can tell a rate limit from a bad request.
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export const statusOf = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  if (typeof statusCode === "number") return statusCode;
  return typeof status === "number" ? status : undefined;
};

// Seconds or an HTTP date, as OpenRouter and upstream providers send it.
export const parseRetryAfter = (value: string | null | undefined, now = Date.now()): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

const retryAfterOf = (error: unknown): number | undefined => {
  if (error instanceof HttpError) return error.retryAfterMs;
  const headers = (error as { responseHeaders?: Record<string, string> } | null)?.responseHeaders;
  return parseRetryAfter(headers?.["retry-after"]);
};

// Rate limits, server errors, timeouts and dropped connections are worth another try; 4xx like a bad key are not.
export const isRetryable = (error: unknown) => {
  const status = statusOf(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
    if (error instanceof TypeError && /fetch failed|network|socket/i.test(error.message)) return true;
    const { code } = error as { code?: unknown };
    return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code);
  }
  return false;
};

export type RetryOptions = { retries: number; baseMs: number; maxMs?: number; onRetry?: (error: unknown, attempt: number, delayMs: number) => void };

// Exponential backoff with full jitter; a Retry-After from the server wins when it is longer.
export const withRetry = async <T>(task: () => Promise<T>, { retries, baseMs, maxMs = 60_000, onRetry }: RetryOptions): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      const backoff = Math.random() * Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = Math.min(maxMs, Math.max(backoff, retryAfterOf(error) ?? 0));
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
};
