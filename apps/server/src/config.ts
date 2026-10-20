import path from "node:path";

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`Missing env ${name}`);
  return value;
};

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: requireEnv("DATABASE_URL", "postgres://brygadzista:brygadzista@localhost:5432/brygadzista"),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  dashboardDir: path.resolve(process.env.DASHBOARD_DIR ?? "../dashboard/dist"),
  // Web export of the Expo app (pnpm --filter @brygadzista/mobile export:web), served under /app.
  mobileWebDir: path.resolve(process.env.MOBILE_WEB_DIR ?? "../mobile/dist-web"),
  // Shared tokens from before user accounts (#10). ADMIN_TOKEN stays as emergency admin access (e.g. to create
  // the first owner account); APP_TOKEN is the old app token with access to every project. It is off when set
  // to "", and in production unless set explicitly.
  adminToken: requireEnv("ADMIN_TOKEN", "dev-admin"),
  appToken: process.env.APP_TOKEN ?? (process.env.NODE_ENV === "production" ? "" : "dev-app"),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  // Rate limits per user (or per shared token); login attempts per e-mail and per IP.
  chatRequestsPerMinute: Number(process.env.RATE_LIMIT_CHAT_PER_MINUTE ?? 10),
  uploadsPerHour: Number(process.env.RATE_LIMIT_UPLOADS_PER_HOUR ?? 30),
  loginAttemptsPer15Min: Number(process.env.RATE_LIMIT_LOGIN_PER_15_MIN ?? 10),
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  // Chat about the project: strongest model, served from an EU region.
  agentModel: process.env.AGENT_MODEL ?? "anthropic/claude-opus-5.5",
  agentProvider: process.env.AGENT_PROVIDER ?? "google-vertex/europe",
  // Bulk page indexing (vision): cheaper model, same EU region.
  indexModel: process.env.INDEX_MODEL ?? "anthropic/claude-sonnet-5.5",
  indexProvider: process.env.INDEX_PROVIDER ?? "google-vertex/europe",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "qwen/qwen3-embedding-8b",
  // Empty = any provider that keeps no data (embeddings may leave the EU); set one to pin it.
  embeddingProvider: process.env.EMBEDDING_PROVIDER ?? "",
  embeddingDimensions: 1536,
  indexConcurrency: Number(process.env.INDEX_CONCURRENCY ?? 2),
  // Upload limits: the PDF is streamed to disk and cut off as soon as it passes the size limit.
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024,
  maxPages: Number(process.env.MAX_PAGES ?? 3000),
  // Estimate shown before indexing starts. A page is one vision call (image + up to 12k chars of text)
  // plus a few embeddings; tune both from real runs.
  indexCostPerPageUsd: Number(process.env.INDEX_COST_PER_PAGE_USD ?? 0.03),
  indexSecondsPerPage: Number(process.env.INDEX_SECONDS_PER_PAGE ?? 20),
  // Model calls: per-request timeout and retries with exponential backoff on 429/5xx and timeouts.
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 180_000),
  llmMaxRetries: Number(process.env.LLM_MAX_RETRIES ?? 5),
  llmRetryBaseMs: Number(process.env.LLM_RETRY_BASE_MS ?? 2000),
  // poppler calls on huge sheets can hang on broken files.
  pdfToolTimeoutMs: Number(process.env.PDF_TOOL_TIMEOUT_MS ?? 120_000),
  // After this many failed pages in a row the problem is not the page (key, outage), so the document stops.
  maxConsecutivePageFailures: Number(process.env.MAX_CONSECUTIVE_PAGE_FAILURES ?? 5),
  // Scripted agent for building the chat UIs without an OpenRouter key. Never in production.
  fakeAgent: process.env.FAKE_AGENT === "1" && process.env.NODE_ENV !== "production",
};
