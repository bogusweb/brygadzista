import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { resumeConversions } from "./cad.js";
import { failInterruptedCards } from "./cards.js";
import { failInterruptedChecklists } from "./checklists.js";
import { config, usesDefaultDatabasePassword } from "./config.js";
import { migrate } from "./db.js";
import { resumeDefectSpecs } from "./defect-spec.js";
import { resumeDiaryEntries } from "./diary.js";
import { startIngestWorker } from "./ingest.js";
import { sandboxAvailable } from "./sandbox.js";
import { migrateFiles } from "./storage.js";

// Fails here when CONVERTER_SANDBOX=bwrap and bubblewrap cannot run, instead of at the first upload.
console.log(`brygadzista: file converters ${sandboxAvailable() ? "run in the bubblewrap sandbox" : "run without a sandbox"}`);
await migrate();
await migrateFiles();
await failInterruptedChecklists();
await failInterruptedCards();
await startIngestWorker();
void resumeConversions();
void resumeDiaryEntries();
void resumeDefectSpecs();
// Settings that weaken production; the server still starts, so a deploy never fails on them (#168).
if (process.env.NODE_ENV === "production") {
  if (usesDefaultDatabasePassword(config.databaseUrl)) console.warn("brygadzista: the database uses the default password, set POSTGRES_PASSWORD");
  if (config.adminToken && config.adminToken.length < 32) console.warn("brygadzista: ADMIN_TOKEN is shorter than 32 characters");
  if (config.adminToken && !config.adminTokenIps.length) console.warn("brygadzista: ADMIN_TOKEN works from any address; leave it empty or set ADMIN_TOKEN_IPS");
  if (!config.publicUrl) console.warn("brygadzista: PUBLIC_URL is not set, links are built from the Host header");
}
if (config.fakeAgent) console.warn("brygadzista: FAKE_AGENT=1, chat answers come from the scripted test agent");
if (!config.openrouterApiKey) console.warn("brygadzista: OPENROUTER_API_KEY is not set, pages are indexed from PDF text only and the agent cannot answer");
serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, ({ port }) => console.log(`brygadzista: listening on ${port}`));
