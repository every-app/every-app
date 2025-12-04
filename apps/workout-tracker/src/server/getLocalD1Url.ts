import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { parse } from "jsonc-parser";

export function getLocalD1Url() {
  const basePath = path.resolve(".wrangler");

  // Check if .wrangler directory exists
  if (!fs.existsSync(basePath)) {
    console.error(
      "================================================================================",
    );
    console.error("WARNING: .wrangler directory not found");
    console.error("This is expected in CI/non-development environments.");
    console.error(
      "The local D1 database is only available after running 'wrangler dev' which you can trigger by running 'npm run dev'.",
    );
    console.error(
      "================================================================================",
    );
    return null;
  }

  const dbFile = fs
    .readdirSync(basePath, { encoding: "utf-8", recursive: true })
    .find((f) => f.endsWith(".sqlite"));

  if (!dbFile) {
    // Read wrangler.jsonc to get the database name
    const wranglerConfigPath = path.resolve("wrangler.jsonc");
    const wranglerConfig = parse(fs.readFileSync(wranglerConfigPath, "utf-8"));

    const databaseName = wranglerConfig.d1_databases?.[0]?.database_name;

    if (!databaseName) {
      throw new Error(
        "Could not find database_name in wrangler.jsonc d1_databases configuration",
      );
    }

    // Execute the command to initialize the local database
    console.log(`Initializing local D1 database: ${databaseName}...`);
    execSync(
      `npx wrangler d1 execute ${databaseName} --local --command "SELECT 1;"`,
      { stdio: "pipe" },
    );

    // Try to find the db file again after initialization
    const dbFileAfterInit = fs
      .readdirSync(basePath, { encoding: "utf-8", recursive: true })
      .find((f) => f.endsWith(".sqlite"));

    if (!dbFileAfterInit) {
      throw new Error(
        `Failed to initialize local D1 database. The sqlite file was not created.`,
      );
    }

    const url = path.resolve(basePath, dbFileAfterInit);
    return url;
  }

  const url = path.resolve(basePath, dbFile);
  return url;
}
