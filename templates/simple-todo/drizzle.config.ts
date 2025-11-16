import { defineConfig } from "drizzle-kit";
import { getLocalD1Url } from "./src/server/getLocalD1Url";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: getLocalD1Url(),
  },
});
