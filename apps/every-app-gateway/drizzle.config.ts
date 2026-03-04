import { defineConfig } from "drizzle-kit";
import { getLocalD1Url } from "@every-app/sdk/cloudflare/server";

const localUrl = getLocalD1Url();

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: localUrl || "", // Empty fallback for CI/non-dev environments
  },
});
