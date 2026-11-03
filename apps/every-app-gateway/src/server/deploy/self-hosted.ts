/** Self-hosted release installation: the CLI's install engine, with Cloudflare's REST API as its port. */
import { db } from "@/db";
import { apps } from "@/db/schema";
import { gatewayNamesOf } from "@/server/gateway-name";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  buildOutputProblems,
  compareVersions,
  DEFAULT_WORKER,
  installApp,
  InstallationError,
  readOwnedResources,
  recordRestorePoint,
  recordUploadedVersion,
  validateWorkerBuildOutput,
  type BuiltWorkerConfig,
  type InstallationDatabase,
  type InstalledWorker,
  type InstallTarget,
} from "@every-app/perimeter/install";
import { type Manifest } from "@every-app/perimeter/manifest";
import { appResources, type AppRow } from "@every-app/perimeter/registry";
import {
  helperWorkerName,
  sentinelDeployTarget,
} from "@every-app/sdk/cloudflare/sentinel";
import {
  parseEmailList,
  secretEntries,
  settingEntries,
  settingValueProblem,
} from "@every-app/sdk/internal";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { version as gatewayVersion } from "../../../package.json";
import type { DeployBundle } from "./bundle";
import { createCloudflareRest } from "./cf-rest";
import { CloudflareTransport } from "./cf-rest/client";
import { CloudflareApiError, isCloudflareNotFound } from "./cf-rest/errors";
import type { CfRestDeployer } from "./cfRestDeployer";
import { bundleRefused, DeployError } from "./errors";
import { migrateAppDatabase } from "./pipeline";
import { recordDispatchDeployed } from "./registry";
import { syncBrowserAccess } from "./self-hosted-access";
import { emailInstaller } from "./self-hosted-email";
import { selfHostedMetadata, selfHostedModules } from "./self-hosted-metadata";
import {
  accountList,
  accountRequest,
  resourceInstaller,
} from "./self-hosted-resources";

export interface AppInstallConfiguration {
  values?: Record<string, string>;
  allowDeleteDurableObjectData?: boolean;
  allowDeleteWorkflows?: boolean;
  replaceChangedWorkers?: boolean;
  registerProviders?: boolean;
  enableEmailRouting?: boolean;
}

function installationFields(manifest: Manifest) {
  return [
    ...secretEntries(manifest).map((entry) => ({
      name: entry.name,
      secret: true,
      label: entry.name,
      optional: true,
    })),
    ...settingEntries(manifest).map((entry) => ({
      name: entry.name,
      secret: false,
      label: entry.name,
      optional: true,
      default: entry.default,
    })),
    ...(manifest.resources?.hyperdrive ?? []).map((entry) => ({
      name: `${entry.name}_ORIGIN_URL`,
      label: `${entry.name} database URL`,
      secret: true,
      optional: false,
    })),
    ...(manifest.resources?.secretsStore ?? []).map((entry) => ({
      name: entry.name,
      label: `${entry.name} secret value`,
      secret: true,
      optional: false,
    })),
  ];
}

export async function reviewInstallationFields(
  manifest: Manifest,
  organizationId: string,
) {
  const fields = installationFields(manifest);
  if (!fields.some((field) => !field.optional)) return fields;
  const app = await AppRepository.findByAppSlug(manifest.id, organizationId);
  if (!app?.workerName) return fields;
  const tables = await db.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_everyapp_app_resources'`,
  );
  if (!tables.length) return fields;
  const owned = await db.all<{
    kind: string;
    binding: string;
    resource_id: string | null;
  }>(
    sql`SELECT kind, binding, resource_id FROM _everyapp_app_resources WHERE worker_name = ${app.workerName}`,
  );
  return fields.map((field) => ({
    ...field,
    optional:
      field.optional ||
      owned.some(
        (resource) =>
          resource.resource_id &&
          ((resource.kind === "hyperdrive" &&
            field.name === `${resource.binding}_ORIGIN_URL`) ||
            (resource.kind === "secrets-store-secret" &&
              field.name === resource.binding)),
      ),
  }));
}

export function parseInstallConfiguration(
  raw: unknown,
  manifest: Manifest,
): AppInstallConfiguration {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new DeployError(
      "INVALID_REQUEST",
      400,
      "Invalid installation configuration.",
    );
  const input = raw as Record<string, unknown>;
  const values = input.values ?? {};
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new DeployError(
      "INVALID_REQUEST",
      400,
      "Configuration values must be an object.",
    );
  const declared = new Set(
    installationFields(manifest).map((field) => field.name),
  );
  for (const [name, value] of Object.entries(values)) {
    if (
      !declared.has(name) ||
      typeof value !== "string" ||
      value.length > 16_384
    )
      throw new DeployError(
        "INVALID_REQUEST",
        400,
        `Invalid value for ${name}.`,
      );
    const setting = settingEntries(manifest).find(
      (entry) => entry.name === name,
    );
    if (
      setting &&
      settingValueProblem(
        {
          type: setting.type ?? "text",
          values: setting.values ? [...setting.values] : undefined,
        },
        value,
      )
    )
      throw new DeployError(
        "INVALID_REQUEST",
        400,
        `Invalid value for setting ${name}.`,
      );
  }
  for (const name of [
    "allowDeleteDurableObjectData",
    "allowDeleteWorkflows",
    "replaceChangedWorkers",
    "registerProviders",
    "enableEmailRouting",
  ])
    if (input[name] !== undefined && typeof input[name] !== "boolean")
      throw new DeployError("INVALID_REQUEST", 400, `Invalid option ${name}.`);
  return {
    values: values as Record<string, string>,
    allowDeleteDurableObjectData: input.allowDeleteDurableObjectData === true,
    allowDeleteWorkflows: input.allowDeleteWorkflows === true,
    replaceChangedWorkers: input.replaceChangedWorkers === true,
    registerProviders: input.registerProviders === true,
    enableEmailRouting: input.enableEmailRouting === true,
  };
}

function workersOf(bundle: DeployBundle) {
  return [
    { directory: DEFAULT_WORKER, bundle },
    ...[...(bundle.helpers ?? [])].map(([directory, bundle]) => ({
      directory,
      bundle,
    })),
  ];
}

/** The same per-Worker policy release packing applies, before account writes. */
export function selfHostedBundleProblems(
  bundle: DeployBundle,
  manifest: Manifest,
): string[] {
  const target = sentinelDeployTarget(manifest);
  const inputs = {
    ...target,
    declared: manifest.resources,
    helperWorkers: (manifest.workers ?? []).map((helper) =>
      helperWorkerName(target.workerName, helper.name),
    ),
  };
  const problems: string[] = [];
  const releaseBytes = bundle.releaseFiles?.get("release.json");
  const release = releaseBytes
    ? (JSON.parse(new TextDecoder().decode(releaseBytes)) as {
        minCli?: unknown;
      })
    : null;
  if (typeof release?.minCli !== "string")
    problems.push("the release has no minimum toolchain version");
  else if (compareVersions(release.minCli, gatewayVersion) > 0)
    problems.push(
      `the release needs EveryApp ${release.minCli}; update this Gateway before installing`,
    );
  if (
    manifest.migrations?.dialect === "postgresql" ||
    manifest.migrations?.engine === "prisma"
  )
    problems.push(
      "Postgres/Prisma migrations need source and cannot be installed from a release",
    );
  let build: { buildContext?: { mode?: string; isPreview?: boolean } };
  try {
    build = JSON.parse(
      new TextDecoder().decode(
        bundle.releaseFiles?.get(".cloudflare/output/v0/config.json"),
      ),
    );
  } catch {
    return [...problems, "the release has no production Build Output config"];
  }
  if (build.buildContext?.mode !== "production" || build.buildContext.isPreview)
    problems.push("the release is not a production build");
  for (const { bundle: worker } of workersOf(bundle)) {
    validateWorkerBuildOutput(worker.worker);
    selfHostedModules(worker, worker.worker);
  }
  return [...problems, ...buildOutputProblems(builtWorkers(bundle), inputs)];
}

/** The release's Workers, as its Build Output has them, by directory. */
function builtWorkers(bundle: DeployBundle): Map<string, BuiltWorkerConfig> {
  return new Map(
    workersOf(bundle).map(({ directory, bundle }) => [
      directory,
      bundle.worker as BuiltWorkerConfig,
    ]),
  );
}

function gatewayDatabase(): InstallationDatabase {
  return {
    run: async (statements) => {
      if (!statements.length) return [];
      const prepared = statements.map((statement) =>
        env.DB.prepare(statement.sql).bind(...(statement.params ?? [])),
      );
      const results = await env.DB.batch(prepared);
      return results.map(
        (result) => result.results as Record<string, unknown>[],
      );
    },
  };
}

export async function runSelfHostedInstall(
  input: Parameters<typeof installSelfHosted>[0],
): Promise<AppRow> {
  try {
    return await installSelfHosted(input);
  } catch (error) {
    // Cloudflare errors may repeat a submitted URL or credential. Keep raw
    // API response bodies out of job records and logs.
    if (error instanceof CloudflareApiError)
      throw new InstallationError(
        error.status === 403
          ? "CLOUDFLARE_PERMISSION_REQUIRED"
          : "CLOUDFLARE_API_ERROR",
        `${error.context} failed (HTTP ${error.status}). Check the Gateway's Cloudflare token permissions and account configuration.`,
      );
    throw error;
  }
}

/** Nothing a browser install says as it goes is shown: the job records how it ended. */
const QUIET = { emit: () => undefined };

/**
 * One browser install of a release, on the install engine `everyapp
 * deploy` runs (@every-app/perimeter/install app-install.ts), with
 * Cloudflare's REST API as its port. What `cf deploy --prebuilt` does for
 * the CLI is the upload port's here: each Worker's metadata from its
 * installed Build Output (./self-hosted-metadata.ts) with its Durable
 * Object migration, its assets, then its Workflows, crons and queue
 * consumers. Then the registry records the version and the Gateway binds it.
 */
async function installSelfHosted(input: {
  app: AppRow;
  manifest: Manifest;
  bundle: DeployBundle;
  gatewayUrl: string;
  identityPublicKey: string;
  deployer: CfRestDeployer;
  renew: () => Promise<void>;
  actor: string;
  configuration?: AppInstallConfiguration;
  previousManifest?: Manifest | null;
}): Promise<AppRow> {
  const { app, manifest, bundle, renew, configuration = {} } = input;
  const workerName = app.workerName!;
  const problems = selfHostedBundleProblems(bundle, manifest);
  if (problems.length) throw bundleRefused(problems);
  const gatewayDb = gatewayDatabase();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID!;
  const transport = {
    apiToken: env.CF_DEPLOY_TOKEN!,
    accountId,
    fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
      await renew();
      return fetch(request, { ...init, signal: AbortSignal.timeout(15_000) });
    },
  };
  const cf = new CloudflareTransport(transport);
  const api = createCloudflareRest(transport);
  const previous = input.previousManifest ?? null;
  // Only the app's own secrets and settings ride along with its version.
  const appValues = new Set(
    [...secretEntries(manifest), ...settingEntries(manifest)].map(
      (entry) => entry.name,
    ),
  );
  const values = Object.fromEntries(
    Object.entries(configuration.values ?? {}).filter(([name]) =>
      appValues.has(name),
    ),
  );
  const workerSettings = (name: string) =>
    optionalAccount<{
      bindings?: Array<{
        type: string;
        name: string;
        class_name?: string;
        script_name?: string;
      }>;
    }>(cf, ["workers", "scripts", name, "settings"]);

  const { versionId, secretNames } = await installApp(
    {
      manifest,
      previousManifest: previous,
      workerName,
      resources: appResources({
        workerName,
        manifest: JSON.stringify(manifest),
      }),
      recordedVersionId: app.versionId,
      organizationId: app.organizationId,
      accountId,
      gatewayUrl: input.gatewayUrl,
      gatewayWorker: gatewayNamesOf(env).worker,
      identityPublicKeys: [input.identityPublicKey],
      secrets: configuration.values,
      values,
      readEmail: async () => {
        const [rows = []] = await gatewayDb.run([
          {
            sql: "SELECT email_senders, email_inbound FROM apps WHERE id = ?",
            params: [app.id],
          },
        ]);
        return {
          inbound: parseEmailList(rows[0]?.email_inbound),
          senders: parseEmailList(rows[0]?.email_senders),
        };
      },
      sendersSettable: false,
      interactive: false,
      enableEmailRouting: configuration.enableEmailRouting,
      allowDeleteDurableObjectData: configuration.allowDeleteDurableObjectData,
      allowDeleteWorkflows: configuration.allowDeleteWorkflows,
    },
    {
      cf,
      db: gatewayDb,
      out: QUIET,
      CLI: "everyapp",
      thisCommand: () => "",
      resources: resourceInstaller,
      email: emailInstaller,
      getWorkflow: (cf, name) =>
        optionalAccount<{ script_name?: string }>(cf, ["workflows", name]),
      deleteWorkflow: async (cf, name) => {
        try {
          await accountRequest(cf, ["workflows", name], "DELETE");
        } catch (error) {
          if (!isCloudflareNotFound(error)) throw error;
        }
      },
      workerSecretNames: async (_cf, name) =>
        ((await workerSettings(name))?.bindings ?? [])
          .filter((binding) => binding.type === "secret_text")
          .map((binding) => binding.name),
      readBuildOutput: async () => builtWorkers(bundle),
      writeBuildOutput: async (workers) => {
        for (const worker of workers) validateWorkerBuildOutput(worker.config);
      },
      // The person confirmed replacing a changed Worker when they started
      // the install, or it is refused.
      replaceable: async ({ workerName: name, recordedVersionIds }) => {
        const live = await servingVersion(api, name);
        if (
          live &&
          !recordedVersionIds.includes(live) &&
          !configuration.replaceChangedWorkers
        )
          throw new InstallationError(
            "WORKER_CHANGED",
            `${name} was changed outside EveryApp. Confirm replacement before installing.`,
            { data: { worker: name } },
          );
      },
      migrate: async (resources) => {
        const d1Binding =
          manifest.migrations?.binding ?? manifest.resources?.d1?.[0];
        if (d1Binding && resources.d1?.[d1Binding])
          await migrate(
            cf,
            gatewayDb,
            workerName,
            input.actor,
            resources.d1[d1Binding].id,
            bundle.migrations,
            input.deployer,
          );
      },
      upload: async (worker, values, target) =>
        uploadWorker({
          cf,
          api,
          gatewayDb,
          manifest,
          bundle:
            worker.directory === DEFAULT_WORKER
              ? bundle
              : bundle.helpers!.get(worker.directory)!,
          worker,
          values,
          target,
          appWorker: workerName,
          settings: await workerSettings(worker.workerName),
        }),
      checkpoint: renew,
    },
  );

  // Unlisted, the names recorded before stand (the CLI's `status` records them).
  if (secretNames)
    await db
      .update(apps)
      .set({ secretNames: JSON.stringify(secretNames) })
      .where(eq(apps.id, app.id));
  const deployed = await recordDispatchDeployed(app.id, {
    versionId,
    manifest,
    actor: input.actor,
  });
  await input.deployer.publishBoundApp(deployed, input.gatewayUrl, renew);
  if (
    [manifest, previous].some(
      (manifest) =>
        manifest &&
        (manifest.public?.length ||
          manifest.publicAssets?.length ||
          manifest.bearerRoutes?.paths.length ||
          manifest.mcp),
    )
  )
    await syncBrowserAccess(cf, app.appSlug);
  return deployed;
}

/**
 * What `cf deploy --prebuilt` does for one Worker, through the REST API:
 * its Durable Object migration against the classes it had, its static
 * assets, its script with every binding, its version recorded as
 * EveryApp's, no workers.dev route, then its Workflows, crons and queue
 * consumers.
 */
async function uploadWorker({
  cf,
  api,
  gatewayDb,
  manifest,
  bundle,
  worker,
  values,
  target,
  appWorker,
  settings,
}: {
  cf: CloudflareTransport;
  api: ReturnType<typeof createCloudflareRest>;
  gatewayDb: InstallationDatabase;
  manifest: Manifest;
  bundle: DeployBundle;
  worker: InstalledWorker;
  values: Readonly<Record<string, string>>;
  target: InstallTarget;
  appWorker: string;
  /** The Worker's settings before this upload; null when it is new. */
  settings: {
    bindings?: Array<{
      type: string;
      class_name?: string;
      script_name?: string;
    }>;
  } | null;
}): Promise<string> {
  const { workerName: name, config } = worker;
  const previousClasses =
    settings?.bindings
      ?.filter(
        (binding) =>
          binding.type === "durable_object_namespace" &&
          (!binding.script_name || binding.script_name === name),
      )
      .map((binding) => binding.class_name) ?? [];
  const migrationTag = (await api.scripts.list()).find(
    (script) => script.id === name,
  )?.migration_tag;
  const exports = config.exports ?? {};
  const created = Object.entries(exports).filter(
    ([className, entry]) =>
      entry.type === "durable-object" &&
      (entry.state === undefined || entry.state === "created") &&
      !previousClasses.includes(className),
  );
  const added = created
    .filter(([, entry]) => entry.storage !== "legacy-kv")
    .map(([className]) => className);
  const legacy = created
    .filter(([, entry]) => entry.storage === "legacy-kv")
    .map(([className]) => className);
  const renamed = Object.entries(exports)
    .filter(
      ([className, entry]) =>
        entry.type === "durable-object" &&
        entry.state === "renamed" &&
        previousClasses.includes(className),
    )
    .map(([from, entry]) => ({ from, to: String(entry.renamedTo) }));
  const deleted =
    worker.helper === ""
      ? (target.deletedDurableObjects ?? []).filter((className) =>
          previousClasses.includes(className),
        )
      : [];
  const metadata = selfHostedMetadata(config, target, manifest, values);
  if (added.length || legacy.length || deleted.length || renamed.length)
    metadata.migrations = {
      ...(migrationTag ? { old_tag: migrationTag } : {}),
      new_tag: `everyapp-${crypto.randomUUID()}`,
      ...(added.length ? { new_sqlite_classes: added } : {}),
      ...(legacy.length ? { new_classes: legacy } : {}),
      ...(deleted.length ? { deleted_classes: [...deleted] } : {}),
      ...(renamed.length ? { renamed_classes: renamed } : {}),
    };
  if (bundle.assets.size) {
    const jwt = await api.workerAssets.upload(
      name,
      Object.fromEntries(
        [...bundle.assets].map(([path, bytes]) => [path, { bytes }]),
      ),
    );
    metadata.assets = {
      jwt,
      config: selfHostedMetadata(config, target, manifest, values, jwt).assets
        ?.config,
    };
  }
  await api.scripts.upload(name, {
    metadata,
    modules: selfHostedModules(bundle, config),
  });
  const version = await servingVersion(api, name);
  if (!version)
    throw new InstallationError(
      "DEPLOYMENT_VERSION_MISSING",
      "Cloudflare did not report a serving Worker version.",
    );
  await recordUploadedVersion(gatewayDb, appWorker, version, worker.helper);
  await api.scripts.disableSubdomain(name);
  for (const [class_name, options] of Object.entries(exports)) {
    if (options.type !== "workflow") continue;
    const retention = options.defaultRetention as
      | {
          successRetention?: string | number;
          errorRetention?: string | number;
        }
      | undefined;
    const schedules = options.schedules;
    await accountRequest(cf, ["workflows", String(options.name)], "PUT", {
      class_name,
      script_name: name,
      limits: options.limits,
      concurrency: options.concurrency,
      jurisdiction: options.jurisdiction,
      ...(schedules
        ? {
            schedules: (Array.isArray(schedules) ? schedules : [schedules]).map(
              (cron) => ({ cron }),
            ),
          }
        : {}),
      ...(retention
        ? {
            default_retention: {
              success_retention: retention.successRetention,
              error_retention: retention.errorRetention,
            },
          }
        : {}),
    });
  }
  await accountRequest(
    cf,
    ["workers", "scripts", name, "schedules"],
    "PUT",
    (config.triggers ?? [])
      .filter((trigger) => trigger.type === "scheduled")
      .map((trigger) => ({ cron: trigger.schedule })),
  );
  await reconcileQueueConsumers(cf, name, config, [
    ...Object.values(target.resources.queues ?? {}).map((queue) => queue.name),
    ...(await readOwnedResources(gatewayDb, appWorker))
      .filter((resource) => resource.kind === "queue")
      .map((resource) => resource.name),
  ]);
  return version;
}

async function servingVersion(
  api: ReturnType<typeof createCloudflareRest>,
  worker: string,
): Promise<string | null> {
  try {
    const { deployments } = await api.scripts.deployments(worker);
    const versions = [...deployments].sort((a, b) =>
      b.created_on.localeCompare(a.created_on),
    )[0]?.versions;
    if (!versions?.length) return null;
    if (versions.length !== 1 || versions[0]!.percentage !== 100)
      throw new InstallationError(
        "WORKER_CHANGED",
        "This Worker has a gradual deployment. Reconcile it before installing.",
      );
    return versions[0]!.version_id;
  } catch (error) {
    if (isCloudflareNotFound(error)) return null;
    throw error;
  }
}

async function optionalAccount<T>(
  cf: CloudflareTransport,
  segments: string[],
): Promise<T | null> {
  try {
    return await accountRequest<T>(cf, segments);
  } catch (error) {
    if (isCloudflareNotFound(error)) return null;
    throw error;
  }
}

async function migrate(
  cf: CloudflareTransport,
  registry: InstallationDatabase,
  worker: string,
  actor: string,
  database: string,
  migrations: DeployBundle["migrations"],
  deployer: CfRestDeployer,
): Promise<void> {
  if (!migrations.length) return;
  const query = (sql: string, params: Array<string | number | null> = []) =>
    accountRequest<
      Array<{ success?: boolean; results?: Record<string, unknown>[] }>
    >(cf, ["d1", "database", database, "query"], "POST", { sql, params });
  const tables = await query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
  );
  const done = new Set(
    tables[0]?.results?.length
      ? (await query("SELECT name FROM d1_migrations"))[0]?.results?.map(
          (row) => String(row.name),
        )
      : [],
  );
  const pending = migrations.filter((migration) => !done.has(migration.name));
  if (pending.length && done.size) {
    const { bookmark } = await accountRequest<{ bookmark: string }>(cf, [
      "d1",
      "database",
      database,
      "time_travel",
      "bookmark",
    ]);
    if (!bookmark)
      throw new InstallationError(
        "RESTORE_POINT_MISSING",
        "Cloudflare did not return a database restore point. No migration was applied.",
      );
    await recordRestorePoint(registry, {
      target: `app:${worker}`,
      databaseId: database,
      bookmark,
      migrations: pending.map((migration) => migration.name),
      createdAt: Date.now(),
      createdBy: actor,
    });
  }
  await migrateAppDatabase(deployer, database, migrations);
}

async function reconcileQueueConsumers(
  cf: CloudflareTransport,
  worker: string,
  config: BuiltWorkerConfig,
  knownQueues: readonly string[],
): Promise<void> {
  const triggers = (config.triggers ?? []).filter(
    (trigger) => trigger.type === "queue",
  );
  const queues = new Set([
    ...knownQueues,
    ...triggers.map((trigger) => String(trigger.name)),
  ]);
  if (!queues.size) return;
  const listed = await accountRequest<
    Array<{ queue_id: string; queue_name: string }>
  >(cf, ["queues"]);
  for (const name of queues) {
    const named = listed.find((candidate) => candidate.queue_name === name);
    if (!named) {
      if (!triggers.some((trigger) => trigger.name === name)) continue;
      throw new InstallationError(
        "QUEUE_MISSING",
        `Queue ${name} could not be found.`,
      );
    }
    const consumers = await accountList<{
      consumer_id: string;
      script_name?: string;
      script?: string;
    }>(cf, ["queues", named.queue_id, "consumers"]);
    const owned = consumers.filter(
      (consumer) => (consumer.script_name ?? consumer.script) === worker,
    );
    const trigger = triggers.find((trigger) => trigger.name === name);
    if (!trigger) {
      for (const consumer of owned)
        await accountRequest(
          cf,
          ["queues", named.queue_id, "consumers", consumer.consumer_id],
          "DELETE",
        );
    } else {
      const body = {
        type: "worker",
        script_name: worker,
        settings: {
          batch_size: trigger.maxBatchSize,
          max_retries: trigger.maxRetries,
          max_wait_time_ms:
            typeof trigger.maxBatchTimeout === "number"
              ? trigger.maxBatchTimeout * 1000
              : undefined,
          retry_delay: trigger.retryDelay,
          max_concurrency: trigger.maxConcurrency,
        },
        ...(trigger.deadLetterQueue
          ? { dead_letter_queue: trigger.deadLetterQueue }
          : {}),
      };
      if (owned[0])
        await accountRequest(
          cf,
          ["queues", named.queue_id, "consumers", owned[0].consumer_id],
          "PUT",
          body,
        );
      else
        await accountRequest(
          cf,
          ["queues", named.queue_id, "consumers"],
          "POST",
          body,
        );
    }
  }
}
