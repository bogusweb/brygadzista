import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { startIngestWorker } from "./ingest.js";

await migrate();
await startIngestWorker();
if (config.fakeAgent) console.warn("brygadzista: FAKE_AGENT=1, chat answers come from the scripted test agent");
serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, ({ port }) => console.log(`brygadzista: listening on ${port}`));
