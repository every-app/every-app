import type { LocalContext } from "@/context";
import { localD1Id } from "@every-app/sdk/cloudflare";
import { ManifestError, workerNameFor } from "@every-app/perimeter/manifest";
import {
  connectToGatewayAccount,
  gatewayCall,
} from "@/commands/app/deploy/deployApp";
import {
  applyLocalMigrations,
  devRegistryEnv,
  legacyLocalStateNote,
} from "@/lib/app/localD1";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database, queryD1 } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { createCfRunner, runCfJson, type CfRunner } from "@/lib/cf/runner";
import { D1RawOutput } from "@/lib/cf/schemas";
import { EveryAppError } from "@/lib/errors";
import { setExitCode } from "@/lib/exit-code";
import { GatewayClient } from "@/lib/gateway/api";
import { resolveGatewayUrl } from "@/lib/gateway/resolve";
import { loadEveryAppManifest, resolveMigrationBinding } from "@/lib/manifest";
import { eventSink, runReported } from "@/lib/output/run";
import {
  createHumanSink,
  createNdjsonSink,
  type EventSink,
} from "@/lib/output/events";

interface MigrateCommandFlags {
  local?: boolean;
  json?: boolean;
}

const STEP = "migrations.local";

/**
 * `everyapp app d1 migrate --local`: apply the app's migrations to the local
 * D1 database `cf dev` serves. Remote migrations run in `everyapp app deploy`.
 */
export async function migrate(
  this: LocalContext,
  flags: MigrateCommandFlags,
): Promise<void> {
  const out = flags.json ? createNdjsonSink() : createHumanSink();
  await migrateLocal({ cwd: process.cwd(), out, local: flags.local ?? false });
  setExitCode(out.exitCode);
}

interface MigrateLocalOptions {
  cwd: string;
  out: EventSink;
  local: boolean;
  cf?: CfRunner;
}

export async function migrateLocal({
  cwd,
  out,
  local,
  cf = createCfRunner(),
}: MigrateLocalOptions): Promise<void> {
  if (!local) {
    out.emit({
      type: "error",
      code: "REMOTE_MIGRATIONS_UNSUPPORTED",
      message:
        "Remote migrations run as part of `everyapp app deploy`. Pass --local to migrate the database `everyapp dev` uses.",
      retryable: false,
    });
    return;
  }

  try {
    const manifest = await loadEveryAppManifest(cwd);
    const note = await legacyLocalStateNote(cwd);
    if (note)
      out.emit({ type: "warning", code: "LEGACY_LOCAL_STATE", message: note });

    out.emit({
      type: "step",
      step: STEP,
      status: "start",
      message: "Applying local database migrations...",
    });
    const result = await applyLocalMigrations({ cwd, manifest, cf });
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
    } else {
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
    out.emit({ type: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.emit({ type: "step", step: STEP, status: "fail", data: { message } });
    out.emit({
      type: "error",
      code:
        error instanceof ManifestError
          ? "INVALID_MANIFEST"
          : "MIGRATIONS_FAILED",
      message: `Failed to apply local database migrations: ${message}`,
      retryable: false,
      step: STEP,
    });
  }
}

interface QueryCommandFlags {
  local?: boolean;
  binding?: string;
  gateway?: string;
  json?: boolean;
}

/**
 * `everyapp app d1 query "<sql>"`: run SQL against the app's production D1
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
      gatewayUrl: flags.local ? undefined : await resolveGatewayUrl(flags.gateway),
      json: flags.json,
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
  gatewayUrl?: string;
  json?: boolean;
  cf?: CfRunner;
  client?: GatewayClient;
  createCf?: (accountId?: string) => CfRunner;
}

/** Each statement's rows. */
export async function queryAppD1({
  cwd,
  sql,
  local,
  binding,
  gatewayUrl,
  json,
  cf = createCfRunner(),
  client,
  createCf = (accountId?: string) => createCfRunner({ accountId }),
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

  const gateway = client ?? new GatewayClient({ gatewayUrl: gatewayUrl! });
  const info = await gatewayCall(() => gateway.appInfo(manifest.id));
  const name = info.resources.d1[target];
  const { cf: accountCf, gatewayDb } = await connectToGatewayAccount({
    client: gateway,
    interactive: canPromptInTerminal(json ?? false),
    createCf,
  });
  // The database the app created and recorded.
  const owned = await readOwnedResources(
    cfD1Database(accountCf, gatewayDb),
    info.workerName,
  );
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
