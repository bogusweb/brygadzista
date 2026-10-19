import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API runs separately (apps/server on :3000); in production the server serves this build.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" },
  },
});
