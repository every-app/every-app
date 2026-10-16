import type { LocalContext } from "@/context";
import { localD1Id } from "@every-app/sdk/cloudflare";
import { workerNameFor } from "@every-app/perimeter/manifest";
import {
  applyLocalMigrations,
  devRegistryEnv,
  legacyLocalStateNote,
} from "@/lib/app/localD1";
import { readOwnedResources } from "@/lib/app/ownership";
import { deviceLoginAction } from "@/lib/cf/account";
import { queryD1 } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { createCfRunner, runCfJson, type CfRunner } from "@/lib/cf/runner";
import { D1RawOutput } from "@/lib/cf/schemas";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readApp } from "@/lib/gateway/registry";
import { loadEveryAppManifest, resolveMigrationBinding } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";

interface MigrateCommandFlags {
  /** The only database it migrates; said for symmetry with `db query`. */
  local?: boolean;
  json?: boolean;
}

const STEP = "migrations.local";

/**
 * `everyapp db migrate`: apply the app's migrations to the local D1
 * database `cf dev` and `everyapp dev` serve. Production migrations run in
 * `everyapp deploy`, bookmarked first, and nowhere else.
 */
export async function migrate(
  this: LocalContext,
  flags: MigrateCommandFlags,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
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
  const note = await legacyLocalStateNote(cwd);
  if (note) {
    out.emit({ type: "warning", code: "LEGACY_LOCAL_STATE", message: note });
  }

  out.emit({
    type: "step",
    step: STEP,
    status: "start",
    message: "Applying local database migrations...",
  });
  let result: Awaited<ReturnType<typeof applyLocalMigrations>>;
  try {
    result = await applyLocalMigrations({ cwd, manifest, cf });
  } catch (error) {
    throw new EveryAppError(
      "MIGRATIONS_FAILED",
      `Failed to apply local database migrations: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status === "skipped") {
    out.emit({
      type: "step",
      step: STEP,
      status: "skip",
      message:
        result.reason === "no_d1"
          ? "The app declares no D1 database."
          : "The app has no migrations directory yet.",
      data: { reason: result.reason },
    });
    return;
  }
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message:
      result.applied.length > 0
        ? `Applied ${result.applied.join(", ")}.`
        : "The local database is up to date.",
    data: { database: result.database, applied: result.applied },
  });
}

interface QueryCommandFlags {
  local?: boolean;
  binding?: string;
  gateway?: string;
  "account-id"?: string;
  json?: boolean;
}

/**
 * `everyapp db query "<sql>"`: run SQL against the app's production D1
 * database (with your Cloudflare login, in the gateway's account), or with
 * --local against the database `everyapp dev` uses.
 */
export async function query(
  this: LocalContext,
  flags: QueryCommandFlags,
  sql: string,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
    const results = await queryAppD1({
      cwd: process.cwd(),
      sql,
      local: flags.local ?? false,
      binding: flags.binding,
      gateway: flags.local ? undefined : requestedGatewayUrl(flags.gateway),
      accountId: flags["account-id"],
      json: flags.json,
      out,
    });
    out.emit({
      type: "done",
      message: JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
      data: { results },
    });
  });
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
  json?: boolean;
  /** Under --json, cf's device login goes here, and the run waits for it. */
  out?: EventSink;
  cf?: CfRunner;
  createCf?: (accountId?: string) => CfRunner;
}

/** Each statement's rows. */
export async function queryAppD1({
  cwd,
  sql,
  local,
  binding,
  gateway,
  accountId,
  json,
  out,
  cf = createCfRunner(),
  createCf,
}: QueryAppD1Options): Promise<Array<Record<string, unknown>[]>> {
  const manifest = await loadEveryAppManifest(cwd);
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length === 0) {
    throw new EveryAppError("NO_D1", "everyapp.config.ts declares no D1 database.");
  }
  const target = binding ?? resolveMigrationBinding(bindings, manifest.migrations);
  if (!bindings.includes(target)) {
    throw new EveryAppError("NO_D1", `everyapp.config.ts declares no D1 binding ${target}.`);
  }

  if (local) {
    const results = await runCfJson(
      cf,
      {
        plane: "project",
        cwd,
        local: true,
        env: devRegistryEnv(cwd),
        args: [
          "d1",
          "raw",
          localD1Id(workerNameFor(manifest.id), target),
          "--local",
          "--persist-to",
          ".cloudflare/state",
          "--sql",
          sql,
        ],
      },
      D1RawOutput,
    );
    return results.map(({ results: table }) =>
      (table?.rows ?? []).map((row) =>
        Object.fromEntries(
          (table?.columns ?? []).map((column, index) => [column, row[index]]),
        ),
      ),
    );
  }

  const { cf: accountCf, db } = await connectToGateway({
    gateway,
    accountId,
    interactive: canPromptInTerminal(json ?? false),
    onDeviceLogin: json && out ? deviceLoginAction(out, "db.login") : undefined,
    createCf,
  });
  const app = await readApp(db, manifest.id);
  const name = app.resources.d1[target];
  // The database the app created and recorded.
  const owned = await readOwnedResources(db, app.workerName);
  const databaseId = owned.find(
    (r) => r.kind === "d1" && r.binding === target,
  )?.resourceId;
  if (!databaseId) {
    throw new EveryAppError(
      "D1_NOT_FOUND",
      `The app's ${target} database (${name ?? "unnamed"}) doesn't exist yet; deploy the app first.`,
    );
  }
  return queryD1(accountCf, databaseId, [{ sql }]);
}
