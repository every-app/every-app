import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { parse } from "jsonc-parser";

/**
 * Resolve the local miniflare D1 sqlite file path for drizzle-kit. Inlined into
 * the gateway in v2 (previously lived in the now-deleted SDK client surface).
 */
function findSqliteFile(basePath: string): string | undefined {
  if (!fs.existsSync(basePath)) return undefined;
  const files = fs
    .readdirSync(basePath, { encoding: "utf-8", recursive: true })
    .filter((file) => file.endsWith(".sqlite"))
    .map((file) => ({
      file,
      stats: fs.statSync(path.join(basePath, file)),
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
}

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
    console.error(
      "WARNING: .wrangler not found — local D1 is only available after `npm run dev`.",
    );
    return null;
  }

  let dbFile = findSqliteFile(d1Path);
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
    execSync(
      `npx wrangler d1 execute ${databaseName} --local --persist-to .wrangler/state -c .everyapp/wrangler.json --command "SELECT 1;"`,
      { stdio: "pipe" },
    );
    dbFile = findSqliteFile(d1Path);
    if (!dbFile) {
      throw new Error("Failed to initialize local D1 database.");
    }
  }
  return path.resolve(d1Path, dbFile);
}
