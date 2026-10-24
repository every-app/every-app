import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { localD1Id } from "@every-app/sdk/cloudflare";
import { workerNameFor } from "@every-app/perimeter/manifest";
import {
  applyLocalMigrations,
  devRegistryEnv,
  listPendingLocalMigrations,
  LocalMigrationsSkipped,
} from "@/lib/app/localD1";
import { readOwnedResources } from "@/lib/app/ownership";
import { queryD1Results, sqlError, type D1Result } from "@/lib/cf/d1";
import { CfError } from "@/lib/cf/errors";
import { canPromptInTerminal, confirmUnlessYes, type Confirm } from "@/lib/output/prompt";
import { createCfRunner, runCfJson, type CfRunner } from "@/lib/cf/runner";
import { D1RawOutput } from "@/lib/cf/schemas";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { isNotFoundError } from "@/lib/file-operations";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readApp } from "@/lib/gateway/registry";
import {
  loadEveryAppManifest,
  migrationsDir,
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import { CLI, thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";
import type { GatewayCommandFlags } from "../flags";
import { localMigrationsApplied, warnLegacyLocalState } from "../localMigrations";
import { formatQueryResults, readsOnly, type Database } from "./queryOutput";

interface MigrateCommandFlags {
  json?: boolean;
  verbose?: boolean;
}

const MIGRATE_STEP = "db.migrate";

/**
 * `everyapp db migrate`: apply the app's migrations to the local D1
 * database `cf dev` and `everyapp dev` serve. Production migrations run in
 * `everyapp deploy`, after a restore point, and nowhere else.
 */
export async function migrate(flags: MigrateCommandFlags,
): Promise<void> {
  await runCommand(flags, async (out) => {
    await migrateLocal({ cwd: process.cwd(), out });
    out.emit({ type: "done" });
  });
}

interface MigrateLocalOptions {
  cwd: string;
  out: EventSink;
  cf?: CfRunner;
}

export async function migrateLocal({
  cwd,
  out,
  cf = createCfRunner(),
}: MigrateLocalOptions): Promise<void> {
  const manifest = await loadEveryAppManifest(cwd);
  await warnLegacyLocalState(cwd, out);

  let result: Awaited<ReturnType<typeof applyLocalMigrations>>;
  try {
    result = await applyLocalMigrations({
      cwd,
      manifest,
      cf,
      // Only once there is something to migrate: no spinner before a skip.
      onApply: () =>
        out.emit({
          type: "step",
          step: MIGRATE_STEP,
          status: "start",
          message: "Applying migrations to the local database...",
        }),
    });
  } catch (error) {
    throw await localMigrationFailed({ cwd, manifest, cf, error });
  }
  if (result.status === "skipped") {
    out.emit({
      type: "step",
      step: MIGRATE_STEP,
      status: "skip",
      message:
        result.reason === LocalMigrationsSkipped.NoD1
          ? `${manifest.id} declares no D1 database, so there's nothing to migrate.`
          : `No migrations in ${migrationsDir(manifest)}/ yet, so there's nothing to migrate.`,
      data: { reason: result.reason },
    });
    return;
  }
  localMigrationsApplied(out, MIGRATE_STEP, result);
}

/**
 * A failed local migration, named: cf applies them in order and stops at
 * the one that fails, so it is the first the database still hasn't applied.
 */
async function localMigrationFailed({
  cwd,
  manifest,
  cf,
  error,
}: {
  cwd: string;
  manifest: EveryAppCliManifest;
  cf: CfRunner;
  error: unknown;
}): Promise<EveryAppError> {
  const { problem, sqliteCode } = sqlError(errorMessage(error));
  // Only to name it: the migration's own error is the one to report.
  const [failed] = await listPendingLocalMigrations({ cwd, manifest, cf }).catch(
    () => [],
  );
  return new EveryAppError(
    "MIGRATIONS_FAILED",
    [
      failed ? `Migration ${failed} failed` : "A local migration failed",
      sqliteCode ? `${problem} (${sqliteCode})` : problem,
    ].join("\n"),
    {
      data: {
        ...(failed ? { migration: failed } : {}),
        fix: `correct ${failed ? path.posix.join(migrationsDir(manifest), failed) : "the migration"}`,
      },
    },
  );
}

interface QueryCommandFlags extends GatewayCommandFlags {
  local?: boolean;
  file?: string;
  binding?: string;
  yes?: boolean;
}

/**
 * `everyapp db query "<sql>"` (or `--file <path|->`): run SQL against the
 * app's production D1 database (with your Cloudflare login, in the
 * Gateway's account), or with --local against the database `everyapp dev`
 * uses. SQL that changes the production database is confirmed first.
 */
export async function query(flags: QueryCommandFlags,
  sql?: string,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const database: Database = flags.local ? "local" : "production";
    const results = await queryAppD1({
      cwd: process.cwd(),
      sql: await readSql(sql, flags.file),
      local: flags.local ?? false,
      binding: flags.binding,
      gateway: flags.local ? undefined : requestedGatewayUrl(flags.gateway),
      accountId: flags["account-id"],
      yes: flags.yes,
      json: flags.json,
      out,
    });
    out.emit({
      type: "done",
      data: {
        database,
        results: results.map((result) => result.rows),
        meta: results.map(({ duration, changes }) => ({ duration, changes })),
      },
      display: formatQueryResults(results, database),
    });
  });
}

/** The SQL to run: the argument, or `--file` (`-`: stdin), never both. */
async function readSql(sql: string | undefined, file: string | undefined): Promise<string> {
  if (sql !== undefined && file !== undefined) {
    throw new EveryAppError("SQL_TWICE", "Pass the SQL or --file, not both", {
      data: { fix: "drop one of them" },
    });
  }
  if (file === undefined) {
    if (sql === undefined) {
      throw new EveryAppError("SQL_REQUIRED", "No SQL to run", {
        data: { fix: "pass it as an argument, or with --file <path> (- for stdin)" },
      });
    }
    return sql;
  }
  if (file === "-") return text(process.stdin);
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new EveryAppError("SQL_FILE_NOT_FOUND", `No file at ${file}`);
    }
    throw error;
  }
}

interface QueryAppD1Options {
  cwd: string;
  sql: string;
  local: boolean;
  binding?: string;
  /** The gateway `--gateway` or EVERYAPP_GATEWAY_URL names. */
  gateway?: string;
  /** The Gateway's Cloudflare account (`--account-id`). */
  accountId?: string;
  /** Change the production database without asking. */
  yes?: boolean;
  json?: boolean;
  out: EventSink;
  cf?: CfRunner;
  createCf?: (accountId?: string) => CfRunner;
  /** A person at a terminal answers (default: one is there, without --json). */
  interactive?: boolean;
  confirm?: Confirm;
}

/** Each statement's rows, time and changes. */
export async function queryAppD1({
  cwd,
  sql,
  local,
  binding,
  gateway,
  accountId,
  yes,
  json,
  out,
  cf = createCfRunner(),
  createCf,
  interactive = canPromptInTerminal(json ?? false),
  confirm,
}: QueryAppD1Options): Promise<D1Result[]> {
  const manifest = await loadEveryAppManifest(cwd);
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length === 0) {
    throw new EveryAppError("NO_D1", `${manifest.id} declares no D1 database`, {
      rerun: `${CLI} deploy`,
      data: { fix: "add a binding to resources.d1 in everyapp.config.ts" },
    });
  }
  const target = binding ?? resolveMigrationBinding(bindings, manifest.migrations);
  if (!bindings.includes(target)) {
    throw new EveryAppError(
      "UNKNOWN_D1_BINDING",
      `No D1 binding ${target} in everyapp.config.ts\nIt declares ${bindings.join(", ")}.`,
      { rerun: thisCommand([], withBinding(process.argv.slice(2), bindings[0]!)) },
    );
  }

  const database: Database = local ? "local" : "production";
  out.emit({ type: "step", step: "db.query", status: "start", data: { database } });
  const results = local
    ? await queryLocal({ cwd, manifest, binding: target, sql, cf })
    : await queryProduction({
        manifest,
        binding: target,
        sql,
        gateway,
        accountId,
        yes,
        json,
        out,
        createCf,
        interactive,
        confirm,
      });
  out.emit({ type: "step", step: "db.query", status: "ok", data: { database } });
  return results;
}

/** The same arguments, with `--binding` naming `binding`. */
function withBinding(argv: readonly string[], binding: string): string[] {
  return argv.map((arg, index) =>
    argv[index - 1] === "--binding"
      ? binding
      : arg.startsWith("--binding=")
        ? `--binding=${binding}`
        : arg,
  );
}

async function queryLocal({
  cwd,
  manifest,
  binding,
  sql,
  cf,
}: {
  cwd: string;
  manifest: EveryAppCliManifest;
  binding: string;
  sql: string;
  cf: CfRunner;
}): Promise<D1Result[]> {
  const results = await failingQuery("local", () =>
    runCfJson(
      cf,
      {
        plane: "project",
        cwd,
        local: true,
        env: devRegistryEnv(cwd),
        args: [
          "d1",
          "raw",
          localD1Id(workerNameFor(manifest.id), binding),
          "--local",
          "--persist-to",
          ".cloudflare/state",
          "--sql",
          sql,
        ],
      },
      D1RawOutput,
    ),
  );
  return results.map(({ results: table, meta }) => ({
    rows: (table?.rows ?? []).map((row) =>
      Object.fromEntries(
        (table?.columns ?? []).map((column, index) => [column, row[index]]),
      ),
    ),
    duration: meta?.duration ?? 0,
    changes: meta?.changes ?? 0,
  }));
}

async function queryProduction({
  manifest,
  binding,
  sql,
  gateway,
  accountId,
  yes,
  json,
  out,
  createCf,
  interactive,
  confirm,
}: {
  manifest: EveryAppCliManifest;
  binding: string;
  sql: string;
  gateway?: string;
  accountId?: string;
  yes?: boolean;
  json?: boolean;
  out: EventSink;
  createCf?: (accountId?: string) => CfRunner;
  interactive: boolean;
  confirm?: Confirm;
}): Promise<D1Result[]> {
  const { cf, db } = await connectToGateway({
    gateway,
    accountId,
    interactive,
    login: { json, out, step: "db.login" },
    createCf,
  });
  const app = await readApp(db, manifest.id);
  // The database the app created and recorded.
  const owned = await readOwnedResources(db, app.workerName);
  const databaseId = owned.find(
    (r) => r.kind === "d1" && r.binding === binding,
  )?.resourceId;
  if (!databaseId) {
    throw new EveryAppError(
      "D1_NOT_FOUND",
      `${manifest.id} has no ${binding} database yet\nIt's created on the app's first deploy.`,
      { rerun: `${CLI} deploy` },
    );
  }
  if (!readsOnly(sql)) {
    await confirmUnlessYes({
      yes,
      interactive,
      confirm,
      question: `Change data in ${manifest.id}'s production database?`,
      unattended: `This SQL can change ${manifest.id}'s production database\nA person at a terminal confirms it first, or --yes does.`,
    });
  }
  return failingQuery("production", () => queryD1Results(cf, databaseId, [{ sql }]));
}

/** The SQL's own error, said as such, when D1 refuses it. */
async function failingQuery<T>(database: Database, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof CfError)) throw error;
    const { problem, sqliteCode } = sqlError(error.message);
    if (!sqliteCode) throw error;
    throw new EveryAppError(
      "QUERY_FAILED",
      `Query failed: ${problem}\n${sqliteCode} from the ${database} database.`,
    );
  }
}
