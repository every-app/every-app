import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Not vite.config.ts: its Cloudflare and TanStack plugins are for the app.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"] },
});
