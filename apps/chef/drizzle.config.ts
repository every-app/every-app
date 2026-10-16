import { defineConfig } from "drizzle-kit";
import { everyAppWorker, localD1Path } from "@every-app/sdk/cloudflare";
import manifest from "./everyapp.config";

// drizzle-kit studio opens the local database `pnpm dev` serves: the D1
// database everyAppWorker() gives `cf dev`. It exists once `pnpm dev` or
// `pnpm run db:migrate:local` has run.
const { env } = everyAppWorker({
  manifest,
  entrypoint: "",
  ctx: { mode: "development" },
});

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: localD1Path(process.cwd(), env.DB.id ?? ""),
  },
});
