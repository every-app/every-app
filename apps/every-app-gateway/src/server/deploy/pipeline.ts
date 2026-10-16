/**
 * One deploy of a third-party app, after the route checked the caller,
 * registered the app and started its job:
 *
 *   1. check the bundle against the hosted policy (./metadata.ts), before
 *      anything is created;
 *   2. find or create the app's D1 databases (only ever its own, through
 *      the resource ledger) and apply its migrations to the migration
 *      binding's database;
 *   3. upload its static assets, then its Worker into the dispatch
 *      namespace with every binding rewritten;
 *   4. read the Worker's bindings back and compare them with what was
 *      sent: on any difference the Worker is deleted and the job fails, so
 *      a Worker with bindings the deployer didn't choose never serves;
 *   5. record the version in the registry (`pending` → `binding`; the
 *      gateway activates it on the first request through the namespace).
 */
import {
  bundleModuleType,
  resourceNameFor,
  type Manifest,
} from "@every-app/perimeter/manifest";
import {
  parseStoredManifest,
  type AppRow,
} from "@every-app/perimeter/registry";
import type { WorkerModule } from "@every-app/cf-rest";
import type { DeployBundle } from "./bundle";
import { bundleRefused, DeployError } from "./errors";
import { ensureAppDatabase } from "./ledger";
import {
  bindingMismatches,
  bundleProblems,
  buildUserWorkerMetadata,
  type ThirdPartyLimits,
} from "./metadata";
import type { DeployerPort } from "./port";
import { recordDispatchDeployed } from "./registry";

interface DeployInput {
  /** The app's registry row, registered for this deploy. */
  app: AppRow;
  manifest: Manifest;
  bundle: DeployBundle;
  deployer: DeployerPort;
  gatewayUrl: string;
  identityPublicKey: string;
  limits: ThirdPartyLimits;
  /** `deployed_by_actor`: `deploy-key:<token id>`. */
  actor: string;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  map: "application/json",
};

function contentType(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[extension];
}

/** The bundle's modules as the upload takes them; files cf wouldn't upload stay out. */
function workerModules(bundle: DeployBundle): WorkerModule[] {
  const declared =
    (
      bundle.worker["manifest"] as {
        modules?: Record<string, { type?: string }>;
      }
    )?.modules ?? {};
  const modules: WorkerModule[] = [];
  for (const [name, content] of bundle.modules) {
    const type = bundleModuleType(name, declared[name]?.type);
    if (type) modules.push({ name, type, content });
  }
  const main = String(
    (bundle.worker["manifest"] as { mainModule?: unknown })?.mainModule,
  );
  if (
    !modules.some((module) => module.name === main && module.type === "esm")
  ) {
    throw bundleRefused([
      `the upload has no ES module ${main}, the Worker's main module`,
    ]);
  }
  return modules;
}

/** Statements of one migration file, as drizzle-kit separates them. */
function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Apply the migrations the database hasn't had, in name order, each with
 * its record in `d1_migrations` (the table `cf d1 migrations apply` keeps,
 * so either tool can carry on) in one transaction. Their names.
 */
async function migrate(
  deployer: DeployerPort,
  databaseId: string,
  migrations: DeployBundle["migrations"],
): Promise<string[]> {
  if (migrations.length === 0) return [];
  const [, done = []] = await deployer.batch(databaseId, [
    {
      sql: 'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    },
    { sql: "SELECT name FROM d1_migrations" },
  ]);
  const applied = new Set(done.map((row) => String(row["name"])));
  const names: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    try {
      await deployer.batch(databaseId, [
        ...statementsOf(migration.sql).map((sql) => ({ sql })),
        {
          sql: "INSERT INTO d1_migrations (name) VALUES (?)",
          params: [migration.name],
        },
      ]);
    } catch (error) {
      throw new DeployError(
        "MIGRATION_FAILED",
        422,
        `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}. Nothing was uploaded; the version that is serving keeps running.`,
      );
    }
    names.push(migration.name);
  }
  return names;
}

export async function runDeploy(input: DeployInput): Promise<AppRow> {
  const { app, manifest, bundle, deployer, limits } = input;
  const workerName = app.workerName;
  if (!workerName)
    throw new DeployError(
      "APP_NOT_REGISTERED",
      409,
      "The app has no Worker name.",
    );

  // 1. Nothing is created for a bundle that can't go.
  const problems = bundleProblems(
    bundle.worker,
    manifest,
    limits,
    bundle.assets.size > 0,
  );
  if (problems.length > 0) throw bundleRefused(problems);
  const modules = workerModules(bundle);

  // 2. Its own databases, migrated before its new code goes up.
  const d1: Record<string, { name: string; id: string }> = {};
  for (const binding of manifest.resources?.d1 ?? []) {
    const name = resourceNameFor(workerName, binding);
    const { id } = await ensureAppDatabase(deployer, {
      workerName,
      binding,
      name,
    });
    d1[binding] = { name, id };
  }
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length > 0) {
    const migrationBinding = manifest.migrations?.binding ?? bindings[0]!;
    const database = d1[migrationBinding];
    if (!database) {
      throw bundleRefused([
        `migrations.binding ${migrationBinding} isn't one of its D1 databases`,
      ]);
    }
    await migrate(deployer, database.id, bundle.migrations);
  }

  // 3. The Worker, every binding the deployer's own.
  const migrationTag = await deployer.scriptMigrationTag(workerName);
  const live =
    migrationTag === undefined ? null : parseStoredManifest(app.manifest);
  const assetsJwt =
    bundle.assets.size > 0
      ? await deployer.uploadAssets(
          workerName,
          Object.fromEntries(
            [...bundle.assets].map(([path, bytes]) => {
              const type = contentType(path);
              return [path, type ? { bytes, contentType: type } : { bytes }];
            }),
          ),
        )
      : undefined;
  const metadata = buildUserWorkerMetadata({
    worker: bundle.worker,
    manifest,
    target: {
      appId: app.appSlug,
      organizationId: app.organizationId,
      workerName,
      gatewayUrl: input.gatewayUrl,
      identityPublicKey: input.identityPublicKey,
      d1,
      limits,
      durableObjects: {
        liveClasses: (live?.resources?.durableObjects ?? []).map((d) =>
          String(d.className),
        ),
        migrationTag: migrationTag ?? null,
      },
      ...(assetsJwt ? { assetsJwt } : {}),
    },
  });
  const { versionId } = await deployer.upload(workerName, {
    metadata,
    modules,
  });

  // 4. What Cloudflare holds is what was sent, or the Worker goes.
  const mismatched = bindingMismatches(
    metadata.bindings ?? [],
    await deployer.bindings(workerName),
    workerName,
  );
  if (mismatched.length > 0) {
    await deployer.deleteScript(workerName);
    throw new DeployError(
      "BINDINGS_MISMATCH",
      502,
      `Cloudflare lists other bindings for ${workerName} than the deployer sent (${mismatched.join(", ")}), so the Worker was deleted. Deploy again; if it happens again, the gateway's operators need to look.`,
    );
  }

  // 5. Live: the registry records it.
  return recordDispatchDeployed(app.id, {
    versionId,
    manifest,
    actor: input.actor,
  });
}
