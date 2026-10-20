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
  adminToken: requireEnv("ADMIN_TOKEN", "dev-admin"),
  appToken: requireEnv("APP_TOKEN", "dev-app"),
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  // Chat about the project: strongest model, served from an EU region.
  agentModel: process.env.AGENT_MODEL ?? "anthropic/claude-opus-5.5",
  agentProvider: process.env.AGENT_PROVIDER ?? "google-vertex/europe",
  // Bulk page indexing (vision): cheaper model, same EU region.
  indexModel: process.env.INDEX_MODEL ?? "anthropic/claude-sonnet-5.5",
  indexProvider: process.env.INDEX_PROVIDER ?? "google-vertex/europe",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "google/gemini-embedding-2",
  embeddingProvider: process.env.EMBEDDING_PROVIDER ?? "google-vertex/eu",
  embeddingDimensions: 1536,
  indexConcurrency: Number(process.env.INDEX_CONCURRENCY ?? 2),
  // Scripted agent for building the chat UIs without an OpenRouter key. Never in production.
  fakeAgent: process.env.FAKE_AGENT === "1" && process.env.NODE_ENV !== "production",
};
