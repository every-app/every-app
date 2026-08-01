import { defineConfig } from "drizzle-kit";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { parse } from "jsonc-parser";

/**
 * Locate (and lazily initialize) the local D1 sqlite file under .wrangler.
 * Inlined from the v1 SDK's getLocalD1Url — dev tooling, not auth-related.
 */
function getLocalD1Url(): string | null {
  const basePath = path.resolve(".wrangler");
  const d1Path = path.join(
    basePath,
    "state",
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
  );

  if (!fs.existsSync(basePath)) {
    console.error("WARNING: .wrangler directory not found (expected in CI).");
    console.error(
      "The local D1 database is created on first `everyapp dev` / `vite dev` run.",
    );
    return null;
  }

  const findSqliteFile = () => {
    if (!fs.existsSync(d1Path)) return undefined;
    const files = fs
      .readdirSync(d1Path, { encoding: "utf-8", recursive: true })
      .filter((file) => file.endsWith(".sqlite"))
      .map((file) => ({
        file,
        stats: fs.statSync(path.join(d1Path, file)),
      }))
      .filter(({ stats }) => stats.isFile())
      .map(({ file, stats }) => ({ file, modified: stats.mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    if (files.length > 1) {
      console.warn(
        `WARNING: multiple local D1 files found; using ${files[0]!.file}.`,
      );
    }
    return files[0]?.file;
  };

  let dbFile = findSqliteFile();

  if (!dbFile) {
    const wranglerConfig = parse(
      fs.readFileSync(path.resolve(".everyapp", "wrangler.json"), "utf-8"),
    );
    const databaseName = wranglerConfig.d1_databases?.[0]?.database_name;
    if (!databaseName) {
      throw new Error(
        "Could not find database_name in .everyapp/wrangler.json",
      );
    }
    console.log(`Initializing local D1 database: ${databaseName}...`);
    execSync(
      `npx wrangler d1 execute ${databaseName} --local --persist-to .wrangler/state -c .everyapp/wrangler.json --command "SELECT 1;"`,
      { stdio: "pipe" },
    );
    dbFile = findSqliteFile();
    if (!dbFile) {
      throw new Error("Failed to initialize local D1 database.");
    }
  }

  return path.resolve(d1Path, dbFile);
}

const localUrl = getLocalD1Url();

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: localUrl || "", // Empty fallback for CI/non-dev environments
  },
});
