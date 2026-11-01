import { defineConfig } from "drizzle-kit";
import { localD1Id, localD1Path } from "@every-app/sdk/cloudflare";

// drizzle-kit studio opens the local database `pnpm dev` serves (the id
// cloudflare.config.ts gives it). It exists once `pnpm dev` or
// `pnpm run db:migrate:local` has run.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: localD1Path(process.cwd(), localD1Id("every-app-gateway", "DB")),
  },
});
