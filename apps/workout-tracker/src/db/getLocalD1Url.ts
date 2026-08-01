import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";

/** Locate and, when needed, initialize Wrangler's local D1 sqlite file. */
export function getLocalD1Url(): string | null {
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
    // Best-effort init for local dev. Any failure (missing generated config,
    // no matching D1 binding — both normal in CI/knip, where drizzle.config.ts
    // is merely loaded for analysis) degrades to the null CI fallback rather
    // than throwing and breaking the tooling that imported this config.
    try {
      // Prefer the checked-in root config: it carries the full local D1 entry
      // (database_name + id) Wrangler needs to resolve `d1 execute --local`.
      // The generated `.everyapp/wrangler.json` omits the id, which makes
      // Wrangler drop the D1 resource. Fall back to it only if root is absent.
      const rootConfigPath = path.resolve("wrangler.jsonc");
      const configPath = fs.existsSync(rootConfigPath)
        ? rootConfigPath
        : path.resolve(".everyapp", "wrangler.json");
      const wranglerConfig = parse(fs.readFileSync(configPath, "utf-8"));
      const databaseName = wranglerConfig.d1_databases?.[0]?.database_name;
      if (!databaseName) {
        throw new Error(`Could not find database_name in ${configPath}`);
      }

      console.log(`Initializing local D1 database: ${databaseName}...`);
      execSync(
        `npx wrangler d1 execute ${databaseName} --local --persist-to .wrangler/state -c ${configPath} --command "SELECT 1;"`,
        { stdio: "pipe" },
      );
      dbFile = findSqliteFile();
    } catch (error) {
      console.error(
        "WARNING: could not initialize local D1 database (expected in CI):",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
    if (!dbFile) return null;
  }

  return path.resolve(d1Path, dbFile);
}
