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
  D1MigrationsListOutput,
  D1QueryOutput,
  D1RestoreOutput,
} from "./schemas";

type D1Value = string | number | null;

/** One statement for `cf d1 query`, with `?` or `?N` parameters. */
export interface D1Statement {
  sql: string;
  params?: D1Value[];
}

type D1Row = Record<string, unknown>;

/** A statement's rows, and what D1 says about running it. */
export interface D1Result {
  rows: D1Row[];
  /** Milliseconds D1 took. */
  duration: number;
  /** Rows the statement inserted, updated or deleted. */
  changes: number;
}

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
    run: async (statements, options) =>
      (await queryD1Results(cf, databaseId, statements, options)).map((result) => result.rows),
  };
}

const MIGRATIONS_TIMEOUT_MS = 600_000;

/**
 * A SQL error as D1 reports it through cf (`no such table: todo:
 * SQLITE_ERROR [code: 7500]`): the problem, and SQLite's code if it named one.
 */
export function sqlError(message: string): { problem: string; sqliteCode?: string } {
  const [, problem = message, sqliteCode] =
    /^([\s\S]*?)(?::\s*(SQLITE_[A-Z_]+))?(?:\s*\[code: \d+\])?$/.exec(message.trim()) ?? [];
  return { problem, ...(sqliteCode ? { sqliteCode } : {}) };
}

/**
 * Run statements against a remote D1 database in one `cf d1 query`
 * request: one as `{sql, params}`, several as a batch. The body travels in
 * a private temp file (`--body @file`), never on argv. Returns each
 * statement's rows, time and changes.
 */
export async function queryD1Results(
  cf: CfRunner,
  databaseId: string,
  statements: readonly D1Statement[],
  { timeoutMs }: D1RunOptions = {},
): Promise<D1Result[]> {
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
  return results.map((result) => ({
    rows: result.results ?? [],
    duration: result.meta?.duration ?? 0,
    changes: result.meta?.changes ?? 0,
  }));
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
 * Put the database back to `bookmark` (Time Travel): whatever was written
 * after it is gone. With `--force`, which cf would otherwise ask for, and
 * answer "no" to itself where no one can type.
 */
export async function restoreD1(
  cf: CfRunner,
  databaseId: string,
  bookmark: string,
): Promise<void> {
  await runCfJson(
    cf,
    {
      plane: "account",
      args: ["d1", "time-travel", "restore", databaseId, "--bookmark", bookmark, "--force"],
    },
    D1RestoreOutput,
  );
}

/**
 * `cf d1 time-travel restore`, for scripts (`rollbackCommand` in --json). It
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

interface RemoteMigrationsOptions {
  cf: CfRunner;
  databaseId: string;
  /** The migrations directory. */
  dir: string;
  /** drizzle's nested layout, `<dir>/<tag>/migration.sql`. */
  nested?: boolean;
}

/** `--dir`, and for drizzle's nested layout `--pattern`, as cf takes them. */
function migrationsDirArgs(dir: string, nested: boolean): string[] {
  const absoluteDir = path.resolve(dir);
  return [
    "--dir",
    absoluteDir,
    ...(nested ? ["--pattern", path.join(absoluteDir, "*", "migration.sql")] : []),
  ];
}

/** The migrations in `dir` the remote database hasn't applied, in the order cf applies them. */
export async function listPendingRemoteMigrations({
  cf,
  databaseId,
  dir,
  nested = false,
}: RemoteMigrationsOptions): Promise<string[]> {
  const pending = await runCfJson(
    cf,
    {
      plane: "account",
      args: ["d1", "migrations", "list", databaseId, ...migrationsDirArgs(dir, nested)],
    },
    D1MigrationsListOutput,
  );
  return pending.map((migration) => migration.Name);
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
}: RemoteMigrationsOptions): Promise<string[]> {
  const applied = await runCfJson(
    cf,
    {
      plane: "account",
      timeoutMs: MIGRATIONS_TIMEOUT_MS,
      args: ["d1", "migrations", "apply", databaseId, ...migrationsDirArgs(dir, nested)],
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
