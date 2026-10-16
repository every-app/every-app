/**
 * Remote D1 through cf: SQL, Time Travel bookmarks and migrations. Account
 * plane throughout, so neither an app's cloudflare.config.ts nor a release
 * directory is ever loaded as a project.
 */
import path from "node:path";
import { PINNED_CF_VERSION } from "./bin";
import { runCfJson, type CfRunner } from "./runner";
import {
  D1BookmarkOutput,
  D1MigrationsApplyOutput,
  D1QueryOutput,
} from "./schemas";

type D1Value = string | number | null;

/** One statement for `cf d1 query`, with `?` or `?N` parameters. */
export interface D1Statement {
  sql: string;
  params?: D1Value[];
}

type D1Row = Record<string, unknown>;

/**
 * A remote D1 database: runs statements in one request and returns each
 * one's rows. `cfD1Database` is the real one; tests use SQLite.
 */
export interface D1Database {
  run(
    statements: readonly D1Statement[],
    options?: D1RunOptions,
  ): Promise<D1Row[][]>;
}

interface D1RunOptions {
  /** Give up on the request after this long (default: the runner's limit). */
  timeoutMs?: number;
}

export function cfD1Database(cf: CfRunner, databaseId: string): D1Database {
  return {
    run: (statements, options) => queryD1(cf, databaseId, statements, options),
  };
}

const MIGRATIONS_TIMEOUT_MS = 600_000;

/**
 * Run statements against a remote D1 database in one `cf d1 query`
 * request: one as `{sql, params}`, several as a batch. The body travels in
 * a private temp file (`--body @file`), never on argv. Returns each
 * statement's rows.
 */
export async function queryD1(
  cf: CfRunner,
  databaseId: string,
  statements: readonly D1Statement[],
  { timeoutMs }: D1RunOptions = {},
): Promise<D1Row[][]> {
  const body = statements.length === 1 ? statements[0] : { batch: statements };
  const results = await runCfJson(
    cf,
    {
      plane: "account",
      ...(timeoutMs ? { timeoutMs } : {}),
      args: (files) => [
        "d1",
        "query",
        databaseId,
        "--body",
        `@${files["query.json"]}`,
      ],
      files: { "query.json": body as object },
    },
    D1QueryOutput,
  );
  return results.map((result) => result.results ?? []);
}

/**
 * A Time Travel bookmark for the database as it is now, to restore with
 * `cf d1 time-travel restore <id> --bookmark <bookmark>`.
 */
export async function getD1Bookmark(
  cf: CfRunner,
  databaseId: string,
): Promise<string> {
  const { bookmark } = await runCfJson(
    cf,
    {
      plane: "account",
      args: ["d1", "time-travel", "get-bookmark", databaseId],
    },
    D1BookmarkOutput,
  );
  return bookmark;
}

/**
 * `cf d1 time-travel restore`, for messages that say how to roll back. It
 * carries `--force`: where no one can type (an agent, a script) cf answers
 * its own confirmation "no" and prints `Aborted.` with exit 0. And the
 * account, which a database id needs when cf can use several: cf takes it
 * only from the environment, set the way the user's shell does it.
 */
export function restoreCommand(
  databaseId: string,
  bookmark: string,
  accountId?: string,
  {
    platform = process.platform,
    shell = process.env["SHELL"],
  }: { platform?: NodeJS.Platform; shell?: string } = {},
): string {
  const restore = `npx cf@${PINNED_CF_VERSION} d1 time-travel restore ${databaseId} --bookmark ${bookmark} --force`;
  if (!accountId) return restore;
  // PowerShell, Windows' default shell, has no `NAME=value command`; Git
  // Bash and its kind (which set SHELL) do.
  return platform === "win32" && !shell
    ? `$env:CLOUDFLARE_ACCOUNT_ID="${accountId}"; ${restore}`
    : `CLOUDFLARE_ACCOUNT_ID=${accountId} ${restore}`;
}

interface ApplyRemoteMigrationsOptions {
  cf: CfRunner;
  databaseId: string;
  /** The migrations directory. */
  dir: string;
  /** drizzle's nested layout, `<dir>/<tag>/migration.sql`. */
  nested?: boolean;
}

/**
 * `cf d1 migrations apply` against the remote database: each pending file
 * runs with its `d1_migrations` row in one request. Returns the names
 * applied (empty when the database was up to date). cf marks a migration
 * whose statements report failure ❌, yet goes on to the next one and exits
 * 0, so any status but ✅ fails here.
 */
export async function applyRemoteMigrations({
  cf,
  databaseId,
  dir,
  nested = false,
}: ApplyRemoteMigrationsOptions): Promise<string[]> {
  const absoluteDir = path.resolve(dir);
  const applied = await runCfJson(
    cf,
    {
      plane: "account",
      timeoutMs: MIGRATIONS_TIMEOUT_MS,
      args: [
        "d1",
        "migrations",
        "apply",
        databaseId,
        "--dir",
        absoluteDir,
        ...(nested
          ? ["--pattern", path.join(absoluteDir, "*", "migration.sql")]
          : []),
      ],
    },
    D1MigrationsApplyOutput,
  );
  const failed = applied.filter((migration) => migration.status !== "✅");
  if (failed.length > 0) {
    throw new Error(
      `cf reported ${failed.map((migration) => `${migration.name} ${migration.status}`).join(", ")} (applying ${applied.map((migration) => migration.name).join(", ")}).`,
    );
  }
  return applied.map((migration) => migration.name);
}
