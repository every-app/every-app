/** Self-hosted release installation, using the CLI's shared policy and provisioner. */
import { db } from "@/db";
import { apps } from "@/db/schema";
import { gatewayNamesOf } from "@/server/gateway-name";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  appPolicyProblems,
  checkDurableObjects,
  compareVersions,
  helperPolicyProblems,
  InstallationError,
  installWorkerConfig,
  readOwnedResources,
  recordRestorePoint,
  recordUploadedVersion,
  validateWorkerBuildOutput,
  type BuiltWorkerConfig,
  type InstallationDatabase,
  type InstallTarget,
} from "@every-app/perimeter/install";
import { type Manifest } from "@every-app/perimeter/manifest";
import { appResources, type AppRow } from "@every-app/perimeter/registry";
import {
  helperWorkerName,
  sentinelDeployTarget,
  workflowNameFor,
} from "@every-app/sdk/cloudflare/sentinel";
import {
  isReservedAppSecretName,
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
import {
  applyEmailRoutes,
  emailDeclarations,
  planEmailRoutes,
} from "./self-hosted-email";
import { selfHostedMetadata, selfHostedModules } from "./self-hosted-metadata";
import {
  accountList,
  accountRequest,
  claimAppWorker,
  ensureAppBuckets,
  provisionAppResources,
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
    { directory: "default", bundle },
    ...[...(bundle.helpers ?? [])].map(([directory, bundle]) => ({
      directory,
      bundle,
    })),
  ];
}

/** The same per-Worker policy as prepareAppBuildOutput, before account writes. */
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
  const problems = appPolicyProblems(bundle.worker, inputs);
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
  const builtNames: string[] = [];
  for (const { directory, bundle: helper } of workersOf(bundle)) {
    validateWorkerBuildOutput(helper.worker);
    selfHostedModules(helper, helper.worker);
    if (directory === "default") continue;
    const name = String(helper.worker.name);
    builtNames.push(name);
    if (!inputs.helperWorkers.includes(name))
      problems.push(`undeclared helper Worker ${name}`);
    else
      problems.push(
        ...helperPolicyProblems(helper.worker, name, inputs).map(
          (problem) => `${name}: ${problem}`,
        ),
      );
  }
  for (const name of inputs.helperWorkers)
    if (!builtNames.includes(name))
      problems.push(`the release has no declared helper Worker ${name}`);
  return problems;
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
  const cf = new CloudflareTransport({
    apiToken: env.CF_DEPLOY_TOKEN!,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    fetch: async (request, init) => {
      await renew();
      return fetch(request, { ...init, signal: AbortSignal.timeout(15_000) });
    },
  });
  const api = createCloudflareRest({
    apiToken: env.CF_DEPLOY_TOKEN!,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    fetch: async (request, init) => {
      await renew();
      return fetch(request, { ...init, signal: AbortSignal.timeout(15_000) });
    },
  });
  const ownership = {
    cf,
    gatewayDb,
    registration: {
      workerName,
      resources: appResources({
        workerName,
        manifest: JSON.stringify(manifest),
      }),
    },
  };
  const helpers = (manifest.workers ?? []).map((helper) => ({
    name: helper.name,
    workerName: helperWorkerName(workerName, helper.name),
  }));
  await claimAppWorker(ownership);
  for (const helper of helpers) await claimAppWorker(ownership, helper);
  const owned = await readOwnedResources(gatewayDb, workerName);
  const configs = workersOf(bundle).map((worker) => ({
    ...worker,
    name:
      worker.directory === "default"
        ? workerName
        : String(worker.bundle.worker.name).replace(
            sentinelDeployTarget(manifest).workerName,
            workerName,
          ),
  }));
  for (const worker of configs) {
    const live = await servingVersion(api, worker.name);
    const recorded = owned.find(
      (resource) => resource.kind === "worker" && resource.name === worker.name,
    )?.versionId;
    if (live && live !== recorded && !configuration.replaceChangedWorkers)
      throw new InstallationError(
        "WORKER_CHANGED",
        `${worker.name} was changed outside EveryApp. Confirm replacement before installing.`,
        { data: { worker: worker.name } },
      );
  }
  const previous = input.previousManifest ?? null;
  const [storedRows = []] = await gatewayDb.run([
    { sql: "SELECT email_inbound FROM apps WHERE id = ?", params: [app.id] },
  ]);
  const inbound = parseEmailList(storedRows[0]?.email_inbound);
  const emailPlan = await planEmailRoutes({
    ...ownership,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    workerName,
    addresses: emailDeclarations(manifest).receives ? inbound : [],
    interactive: false,
    enableRouting: configuration.enableEmailRouting,
  });
  const deletedDurableObjects = checkDurableObjects(
    { previousManifest: previous },
    manifest,
    configuration.allowDeleteDurableObjectData === true,
  );
  const workflows = configs.flatMap((worker) =>
    Object.entries(
      (worker.bundle.worker.exports ?? {}) as NonNullable<
        BuiltWorkerConfig["exports"]
      >,
    )
      .filter(([, entry]) => entry.type === "workflow")
      .map(([class_name, options]) => ({
        name: String(options.name).replace(
          sentinelDeployTarget(manifest).workerName,
          workerName,
        ),
        class_name,
        script_name: worker.name,
        options,
      })),
  );
  for (const workflow of workflows) {
    const existing = await optionalAccount<{ script_name?: string }>(cf, [
      "workflows",
      workflow.name,
    ]);
    if (existing && existing.script_name !== workflow.script_name)
      throw new InstallationError(
        "WORKFLOW_NAME_TAKEN",
        `Workflow ${workflow.name} belongs to another Worker.`,
      );
  }
  const droppedWorkflows = (previous?.resources?.workflows ?? []).filter(
    (workflow) =>
      !workflows.some(
        (current) =>
          current.name === workflowNameFor(workerName, workflow.name),
      ),
  );
  if (droppedWorkflows.length && !configuration.allowDeleteWorkflows)
    throw new InstallationError(
      "WORKFLOW_REMOVED",
      "This update removes Workflows and their instances. Confirm their deletion before installing.",
    );
  const resources = await provisionAppResources({
    ...ownership,
    manifest,
    secrets: configuration.values,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
  });
  const target: InstallTarget = {
    workerName,
    organizationId: app.organizationId,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    gatewayUrl: input.gatewayUrl,
    gatewayWorker: gatewayNamesOf(env).worker,
    identityPublicKeys: [input.identityPublicKey],
    resources,
    deletedDurableObjects,
    helperWorkers: helpers.map((helper) => helper.workerName),
    declared: manifest.resources,
  };
  const installed = configs.map((worker) => ({
    ...worker,
    config: installWorkerConfig(
      worker.bundle.worker,
      target,
    ) as BuiltWorkerConfig,
  }));
  for (const worker of installed) {
    validateWorkerBuildOutput(worker.config);
    const problems =
      worker.directory === "default"
        ? appPolicyProblems(worker.config, target)
        : helperPolicyProblems(worker.config, worker.name, target);
    if (problems.length) throw bundleRefused(problems);
  }
  const buckets = new Set(
    installed.flatMap((worker) =>
      Object.values(worker.config.env ?? {})
        .filter((binding) => binding.type === "r2")
        .map((binding) => String(binding.name)),
    ),
  );
  await ensureAppBuckets({
    ...ownership,
    names: [...buckets],
    appId: manifest.id,
  });
  const values: Record<string, string> = {
    GATEWAY_URL: input.gatewayUrl,
    EVERY_APP_ORG_ID: app.organizationId,
  };
  const appValues = new Set(
    [...secretEntries(manifest), ...settingEntries(manifest)].map(
      (entry) => entry.name,
    ),
  );
  for (const [name, value] of Object.entries(configuration.values ?? {}))
    if (appValues.has(name)) values[name] = value;
  for (const entry of settingEntries(manifest))
    if (entry.default !== undefined && values[entry.name] === undefined) {
      const current = await optionalAccount<{
        bindings?: Array<{ name: string }>;
      }>(cf, ["workers", "scripts", workerName, "settings"]);
      if (!current?.bindings?.some((binding) => binding.name === entry.name))
        values[entry.name] = entry.default;
    }
  // Resource/config validation has completed before migrations touch data,
  // and, as in CLI deploys, before any Worker that reads the schema uploads.
  const d1Binding = manifest.migrations?.binding ?? manifest.resources?.d1?.[0];
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
  // Helpers first: the main Worker can bind them as soon as it is uploaded.
  for (const worker of [
    ...installed.filter((worker) => worker.directory !== "default"),
    ...installed.filter((worker) => worker.directory === "default"),
  ]) {
    const existing = await optionalAccount<{
      bindings?: Array<{
        type: string;
        class_name?: string;
        script_name?: string;
      }>;
    }>(cf, ["workers", "scripts", worker.name, "settings"]);
    const previousClasses =
      existing?.bindings
        ?.filter(
          (binding) =>
            binding.type === "durable_object_namespace" &&
            (!binding.script_name || binding.script_name === worker.name),
        )
        .map((binding) => binding.class_name) ?? [];
    const migrationTag = (await api.scripts.list()).find(
      (script) => script.id === worker.name,
    )?.migration_tag;
    const exports = worker.config.exports ?? {};
    const created = Object.entries(exports).filter(
      ([name, entry]) =>
        entry.type === "durable-object" &&
        (entry.state === undefined || entry.state === "created") &&
        !previousClasses.includes(name),
    );
    const added = created
      .filter(([, entry]) => entry.storage !== "legacy-kv")
      .map(([name]) => name);
    const legacy = created
      .filter(([, entry]) => entry.storage === "legacy-kv")
      .map(([name]) => name);
    const renamed = Object.entries(exports)
      .filter(
        ([name, entry]) =>
          entry.type === "durable-object" &&
          entry.state === "renamed" &&
          previousClasses.includes(name),
      )
      .map(([from, entry]) => ({ from, to: String(entry.renamedTo) }));
    const metadata = selfHostedMetadata(
      worker.config,
      target,
      manifest,
      values,
    );
    const deleted =
      worker.directory === "default"
        ? deletedDurableObjects.filter((name) => previousClasses.includes(name))
        : [];
    if (added.length || legacy.length || deleted.length || renamed.length)
      metadata.migrations = {
        ...(migrationTag ? { old_tag: migrationTag } : {}),
        new_tag: `everyapp-${crypto.randomUUID()}`,
        ...(added.length ? { new_sqlite_classes: added } : {}),
        ...(legacy.length ? { new_classes: legacy } : {}),
        ...(deleted.length ? { deleted_classes: deleted } : {}),
        ...(renamed.length ? { renamed_classes: renamed } : {}),
      };
    if (worker.bundle.assets.size) {
      const jwt = await api.workerAssets.upload(
        worker.name,
        Object.fromEntries(
          [...worker.bundle.assets].map(([path, bytes]) => [path, { bytes }]),
        ),
      );
      metadata.assets = {
        jwt,
        config: selfHostedMetadata(worker.config, target, manifest, values, jwt)
          .assets?.config,
      };
    }
    await api.scripts.upload(worker.name, {
      metadata,
      modules: selfHostedModules(worker.bundle, worker.config),
    });
    const version = await servingVersion(api, worker.name);
    if (!version)
      throw new InstallationError(
        "DEPLOYMENT_VERSION_MISSING",
        "Cloudflare did not report a serving Worker version.",
      );
    await recordUploadedVersion(
      gatewayDb,
      workerName,
      version,
      helpers.find((helper) => helper.workerName === worker.name)?.name ?? "",
    );
    await api.scripts.disableSubdomain(worker.name);
    for (const workflow of workflows.filter(
      (workflow) => workflow.script_name === worker.name,
    )) {
      const retention = workflow.options.defaultRetention as
        | {
            successRetention?: string | number;
            errorRetention?: string | number;
          }
        | undefined;
      const schedules = workflow.options.schedules;
      await accountRequest(cf, ["workflows", workflow.name], "PUT", {
        class_name: workflow.class_name,
        script_name: workflow.script_name,
        limits: workflow.options.limits,
        concurrency: workflow.options.concurrency,
        jurisdiction: workflow.options.jurisdiction,
        ...(schedules
          ? {
              schedules: (Array.isArray(schedules)
                ? schedules
                : [schedules]
              ).map((cron) => ({ cron })),
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
      ["workers", "scripts", worker.name, "schedules"],
      "PUT",
      (worker.config.triggers ?? [])
        .filter((trigger) => trigger.type === "scheduled")
        .map((trigger) => ({ cron: trigger.schedule })),
    );
    await reconcileQueueConsumers(cf, worker.name, worker.config, [
      ...Object.values(resources.queues ?? {}).map((queue) => queue.name),
      ...owned
        .filter((resource) => resource.kind === "queue")
        .map((resource) => resource.name),
    ]);
  }
  for (const workflow of droppedWorkflows) {
    const name = workflowNameFor(workerName, workflow.name);
    const current = await optionalAccount<{ script_name?: string }>(cf, [
      "workflows",
      name,
    ]);
    const owner = workflow.worker
      ? helperWorkerName(workerName, workflow.worker)
      : workerName;
    if (current?.script_name === owner)
      await accountRequest(cf, ["workflows", name], "DELETE");
  }
  if (emailPlan) await applyEmailRoutes({ cf, gatewayDb, plan: emailPlan });
  const bindings = (await api.scripts.settings(workerName)).bindings ?? [];
  const secretNames = bindings
    .filter(
      (binding) =>
        binding.type === "secret_text" &&
        !isReservedAppSecretName(binding.name),
    )
    .map((binding) => binding.name);
  await db
    .update(apps)
    .set({ secretNames: JSON.stringify(secretNames) })
    .where(eq(apps.id, app.id));
  const versionId = await servingVersion(api, workerName);
  const deployed = await recordDispatchDeployed(app.id, {
    versionId: versionId!,
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
