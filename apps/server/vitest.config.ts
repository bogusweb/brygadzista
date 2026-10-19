import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // All files share one database, so they run one after another.
    fileParallelism: false,
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://brygadzista:brygadzista@localhost:5433/brygadzista_test",
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "brygadzista-test-")),
      ADMIN_TOKEN: "test-admin",
      APP_TOKEN: "test-app",
      // Models are mocked in tests; an empty key also keeps any unmocked call from reaching OpenRouter.
      OPENROUTER_API_KEY: "",
      INDEX_CONCURRENCY: "2",
      // Retries in tests wait milliseconds, not seconds.
      LLM_RETRY_BASE_MS: "1",
    },
  },
});
