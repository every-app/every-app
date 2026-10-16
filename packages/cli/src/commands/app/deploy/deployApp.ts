/**
 * Deploying an app, shared by `everyapp app deploy` and `app create`:
 *
 *   1. ask the gateway who we deploy as, and in which Cloudflare account;
 *   2. register: the gateway assigns the Worker, resource and host names
 *      (a new app starts `pending`, unbound);
 *   3. under the app's deploy lease: find or create its D1 and KV (only
 *      ever the app's own), `cf build` with the deploy inputs and check the
 *      built Worker against the app policy and its Workflows' names (each
 *      new or already the app's), check that its drizzle migrations still
 *      describe its schema (steps/checkSchemaDrift.ts), make sure an
 *      unattended run may replace the Worker, and only then (the lease
 *      checked again before each) migrate D1 (bookmark, then
 *      `cf d1 migrations apply`) and upload it
 *      (`cf deploy --prebuilt`, with GATEWAY_URL and EVERY_APP_ORG_ID in
 *      the secrets file; cf creates or updates its Workflows), so a deploy
 *      that can't upload leaves the database alone. Workflows the app
 *      dropped (with --allow-delete-workflows) go once the upload is live;
 *   4. tell the gateway the version is up (`pending` → `binding`), have the
 *      gateway bind the Worker and publish the app's hostname as a Workers
 *      Custom Domain if it doesn't yet (a reconcile of the live gateway
 *      release), activate once the binding answers, and wait for a new
 *      hostname's certificate.
 *
 * A new hostname is checked (DNS records that answer it, the zone's room)
 * right after registering, before anything is created or uploaded.
 * A redeploy of an app the gateway already binds and serves never touches
 * the gateway.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { version as cliVersion } from "../../../../package.json";
import { appBindingName } from "@every-app/perimeter/manifest";
import { checkSchemaDrift } from "@/commands/app/deploy/steps/checkSchemaDrift";
import { syncAppToolsWithGateway } from "@/commands/app/deploy/steps/syncTools";
import { buildApp } from "@/lib/app/buildApp";
import {
  MISSING_CLOUDFLARE_CONFIG,
  readCloudflareConfig,
} from "@/lib/app/cloudflareConfig";
import type { DeployInputs } from "@/lib/app/deployInputs";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { assertAppSecretName } from "@/lib/app/secrets";
import { readOwnedResources, recordUploadedVersion } from "@/lib/app/ownership";
import { claimAppWorker, provisionAppResources } from "@/lib/app/resources";
import {
  appWorkflows,
  assertOwnWorkflows,
  droppedWorkflows,
  type AppWorkflow,
} from "@/lib/app/workflows";
import { ensureCfAuth } from "@/lib/cf/account";
import { cfD1Database } from "@/lib/cf/d1";
import {
  assertReplaceable,
  canPromptInTerminal,
  cfDeploy,
  type Confirm,
} from "@/lib/cf/deploy";
import { CfError } from "@/lib/cf/errors";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { deleteWorkflow } from "@/lib/cf/workflows";
import { waitForCertificates } from "@/lib/domains/certWait";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { preflightDomains } from "@/lib/domains/preflight";
import { afterMigration, EveryAppError } from "@/lib/errors";
import {
  explainGatewayError,
  GatewayApiError,
  GatewayClient,
  type GatewayStatusResponse,
  type GatewayWhoamiResponse,
  type RegisterAppResponse,
} from "@/lib/gateway/api";
import { notDeployedByEveryapp } from "@/lib/gateway/apply";
import { readInstall } from "@/lib/gateway/install";
import { acquireLease } from "@/lib/gateway/lease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { compareVersions } from "@/lib/gateway/release";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import {
  loadEveryAppManifest,
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import { migrateRemoteD1 } from "@/lib/migrations/remote";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { installDependencies } from "@/lib/package-manager";

const ACTIVATE_TIMEOUT_MS = 90_000;
const ACTIVATE_INTERVAL_MS = 3_000;

interface DeployAppOptions {
  cwd: string;
  manifest?: EveryAppCliManifest;
  gatewayUrl: string;
  out: EventSink;
  json?: boolean;
  verbose?: boolean;
  allowDeleteDurableObjectData?: boolean;
  /** Delete the Workflows the app dropped, with their instances (`--allow-delete-workflows`). */
  allowDeleteWorkflows?: boolean;
  /** Publish a new hostname over the DNS record that answers it (`--force-dns`). */
  forceDns?: boolean;
  /** Wait for a new hostname's certificate (default true; `--no-wait-cert`). */
  waitForCertificate?: boolean;
  /**
   * The app's own secrets to send with this version (`app secret set`).
   * They stay on the Worker through later deploys, which don't send them.
   */
  secrets?: Record<string, string>;
  /** Seams for tests. */
  interactive?: boolean;
  confirm?: Confirm;
  createCf?: (accountId?: string) => CfRunner;
  client?: GatewayClient;
  sleep?: (ms: number) => Promise<void>;
  installDeps?: typeof installDependencies;
  reconcile?: ReconcileSeams;
  certificates?: CertificateSeams;
}

/** How a reconcile reads the live gateway, and how long it waits (tests). */
export interface ReconcileSeams {
  readStatus?: (gatewayUrl: string) => Promise<GatewayStatusResponse>;
  sleep?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  leaseWaitMs?: number;
}

/** How the certificate wait checks a hostname, sleeps, and how long it waits (tests). */
interface CertificateSeams {
  isReady?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
}

interface DeployAppResult {
  liveUrl: string;
  gatewayUrl: string;
  organizationId: string;
  hostname: string;
  workerName: string;
  versionId: string;
}

export async function deployApp(
  options: DeployAppOptions,
): Promise<DeployAppResult> {
  const migrated: Migrated = { rollbackCommand: null };
  try {
    return await deploySteps(options, migrated);
  } catch (error) {
    // Once the app's database changed, a failure says how to put it back.
    throw afterMigration(error, migrated.rollbackCommand);
  }
}

/** The command that rolls the app's database back, once this deploy migrated it. */
interface Migrated {
  rollbackCommand: string | null;
}

async function deploySteps(
  options: DeployAppOptions,
  migrated: Migrated,
): Promise<DeployAppResult> {
  const { cwd, out, gatewayUrl } = options;
  const createCf = options.createCf ?? ((accountId?: string) => createCfRunner({ accountId }));
  const client = options.client ?? new GatewayClient({ gatewayUrl });
  const interactive =
    options.interactive ?? canPromptInTerminal(options.json ?? false);

  const manifest = options.manifest ?? (await loadEveryAppManifest(cwd));
  // Before anything is created, migrated or uploaded: a secret named like
  // one of the app's bindings would only fail at upload.
  const bindings = new Set([
    ...(manifest.resources?.d1 ?? []),
    ...(manifest.resources?.kv ?? []),
    ...(manifest.resources?.durableObjects ?? []).map((d) => d.name),
    ...(manifest.resources?.workflows ?? []).map((w) => w.name),
    "ASSETS",
  ]);
  for (const name of Object.keys(options.secrets ?? {})) {
    assertAppSecretName(name);
    if (bindings.has(name)) {
      throw new EveryAppError(
        "SECRET_NAME_TAKEN",
        `${name} is one of ${manifest.id}'s bindings; pick another name for the secret.`,
      );
    }
  }
  const cloudflareConfig = await readCloudflareConfig(cwd);
  if (!cloudflareConfig) {
    throw new EveryAppError("MISSING_CLOUDFLARE_CONFIG", MISSING_CLOUDFLARE_CONFIG);
  }
  if (!cloudflareConfig.usesEveryAppWorker) {
    out.emit({
      type: "warning",
      code: "NONSTANDARD_CLOUDFLARE_CONFIG",
      message:
        "cloudflare.config.ts doesn't use everyAppWorker(); the deploy checks the Worker it builds against the app policy.",
    });
  }

  // 1. Who we deploy as, and where.
  const { whoami, accountId, cf, gatewayDb } = await connectToGatewayAccount({
    client,
    interactive,
    createCf,
  });

  const sdkVersion = await installedSdkVersion(cwd);
  if (sdkVersion && whoami.minSdk && compareVersions(sdkVersion, whoami.minSdk) < 0) {
    throw new EveryAppError(
      "SDK_TOO_OLD",
      `This gateway needs @every-app/sdk ${whoami.minSdk} or newer; the app has ${sdkVersion}. Upgrade it in package.json.`,
    );
  }

  // 2. Register: the gateway names everything.
  const registration = await gatewayCall(() =>
    client.registerApp({
      appId: manifest.id,
      name: manifest.name ?? manifest.id,
      description: manifest.description ?? manifest.id,
      manifest,
      cliVersion,
      ...(sdkVersion ? { sdkVersion } : {}),
    }),
  );
  // A person's first line: where this goes, and (secret set) what for. A
  // new app's says who can open it.
  const secretNames = Object.keys(options.secrets ?? {});
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${registration.existingApp ? "Updating" : "Registered"} ${manifest.id} as ${registration.workerName} at https://${registration.hostname} (${registration.status}).${
      registration.existingApp
        ? ""
        : registration.defaultAccess
          ? " Everyone in the organization can open it."
          : " New apps are private: only you and the organization's owners and admins can open it. Grant others in Admin → Apps."
    }`,
    data: {
      appId: manifest.id,
      workerName: registration.workerName,
      hostname: registration.hostname,
      status: registration.status,
      existingApp: registration.existingApp,
      defaultAccess: registration.defaultAccess,
      organizationName: whoami.organizationName,
      ...(secretNames.length > 0 ? { secrets: secretNames } : {}),
    },
  });

  // A hostname the gateway doesn't serve yet is checked before anything is
  // created or uploaded; the reconcile that publishes it checks again. One
  // that isn't one label below the base is never published, so it is
  // neither checked nor a reason to redeploy the gateway.
  const registry = cfD1Database(cf, gatewayDb);
  const install = await readInstall(registry);
  if (!install) throw notDeployedByEveryapp();
  const outsideBase = !isOneLabelBelow(
    registration.hostname,
    install.appBaseDomain,
  );
  const newHost =
    !outsideBase && !install.liveDomains.includes(registration.hostname);
  if (outsideBase) {
    out.emit({
      type: "warning",
      code: "APP_HOST_OUTSIDE_BASE",
      step: "app.domain",
      message: `${registration.hostname} isn't one label below ${install.appBaseDomain}, so the gateway doesn't publish it and ${manifest.id} can't be reached there.`,
    });
  }
  if (newHost) {
    await preflightDomains({
      cf,
      out,
      step: "app.domain",
      zone: { id: install.zoneId, name: install.zoneName },
      domains: [...install.liveDomains, registration.hostname],
      liveDomains: install.liveDomains,
      forceDns: options.forceDns,
      interactive,
    });
  }

  // 3. Everything that touches the app's Worker and data, one deploy at a time.
  const lease = await acquireLease({
    db: registry,
    id: `app:${registration.workerName}`,
    purpose: "app.deploy",
    onWait: (holder) =>
      out.emit({
        type: "progress",
        step: "app.lease",
        message: `Waiting for another deploy of ${manifest.id} to finish: ${holder.holder}...`,
      }),
    onHeartbeatProblem: (message) =>
      out.emit({ type: "warning", code: "LEASE_HEARTBEAT", step: "app.lease", message }),
  });
  let versionId: string;
  try {
    const deletedDurableObjects = checkDurableObjects(
      registration,
      manifest,
      options.allowDeleteDurableObjectData ?? false,
    );
    const deletedWorkflows = await checkWorkflows({
      cf,
      registration,
      manifest,
      allowDelete: options.allowDeleteWorkflows ?? false,
    });
    // Only what this app created (and recorded as its own) is used; a
    // name that's taken by anything else is refused, on every attempt.
    const ownership = {
      cf,
      gatewayDb: registry,
      registration,
      onCreated: (description: string) =>
        out.emit({ type: "progress", step: "app.resources", message: `Created ${description}.` }),
      onRecreated: (description: string) =>
        out.emit({
          type: "warning",
          code: "RESOURCE_RECREATED",
          step: "app.resources",
          message: `${description}, which ${manifest.id} created before, is gone; creating a new, empty one.`,
        }),
    };
    await claimAppWorker(ownership);
    const resources = await provisionAppResources({ ...ownership, manifest });

    await (options.installDeps ?? installDependencies)({
      cwd,
      description: "Installing dependencies...",
      install: manifest.install,
      verbose: options.verbose ?? false,
    });

    const identity = await gatewayCall(() => client.getIdentityKeys());
    const inputs: DeployInputs = {
      workerName: registration.workerName,
      organizationId: whoami.organizationId,
      gatewayUrl,
      identityIssuer: identity.issuer ?? gatewayUrl,
      identityPublicKeys: identity.keys,
      resources,
      ...(deletedDurableObjects.length ? { deletedDurableObjects } : {}),
    };
    out.emit({ type: "step", step: "app.build", status: "start", message: "Building the app..." });
    await buildApp({
      cwd,
      cf,
      inputs,
      buildCommand: manifest.build,
      env: {},
      verbose: options.verbose ?? false,
    });
    const { workflows } = await prepareAppBuildOutput({ cwd, inputs });
    await assertOwnWorkflows({
      cf,
      workerName: registration.workerName,
      names: workflows,
    });
    out.emit({
      type: "step",
      step: "app.build",
      status: "ok",
      message: "Built the app and checked its Worker.",
      data: { workflows },
    });
    // Migrations that lag the schema would go live with code that needs more.
    await checkSchemaDrift({ cwd, manifest, out });

    // The database changes only once nothing else can stop the upload.
    const workerRecord = (
      await readOwnedResources(registry, registration.workerName)
    ).find((resource) => resource.kind === "worker");
    await assertReplaceable({
      cf,
      workerName: registration.workerName,
      recordedVersionIds: [registration.versionId, workerRecord?.versionId],
      interactive,
      confirm: options.confirm,
    });
    await lease.check();
    migrated.rollbackCommand = await migrate({
      cf,
      out,
      cwd,
      manifest,
      resources,
      accountId,
    });

    await lease.check();
    out.emit({
      type: "step",
      step: "app.upload",
      status: "start",
      message: `Uploading ${registration.workerName}...`,
    });
    const uploaded = await cfDeploy({
      cf,
      cwd,
      workerName: registration.workerName,
      accountId,
      message: `everyapp ${cliVersion} ${manifest.id}`,
      secrets: {
        ...options.secrets,
        GATEWAY_URL: gatewayUrl,
        EVERY_APP_ORG_ID: whoami.organizationId,
      },
      interactive,
      // Recorded at once, before the gateway hears of it: a retry must find
      // this upload was everyapp's, however this run ends.
      onUploaded: (uploadedVersion) =>
        recordUploadedVersion(registry, registration.workerName, uploadedVersion),
    });
    if (!uploaded.versionId) {
      throw new EveryAppError(
        "VERSION_UNKNOWN",
        `cf deployed ${registration.workerName}, but Cloudflare reports no version for it.`,
      );
    }
    versionId = uploaded.versionId;
    out.emit({
      type: "step",
      step: "app.upload",
      status: "ok",
      message: `Uploaded version ${versionId}.`,
      data: { versionId },
    });
    // The live version no longer defines them. Before the gateway records
    // the new manifest, so a retry after a failed delete deletes them still.
    for (const workflow of deletedWorkflows) {
      try {
        await deleteWorkflow(cf, workflow.name);
      } catch (error) {
        if (!(error instanceof CfError && error.kind === "not_found")) throw error;
      }
      out.emit({
        type: "progress",
        step: "app.upload",
        message: `Deleted the Workflow ${workflow.binding} (${workflow.name}) with its instances.`,
      });
    }
    await gatewayCall(() =>
      client.markDeployed(manifest.id, { versionId, manifest }),
    );
  } finally {
    await lease.release();
  }

  // 4. Bind, publish and go live, under the gateway's lease.
  const published = await bindIfNeeded({
    client,
    cf,
    out,
    accountId,
    workerName: registration.workerName,
    publishHost: newHost,
    interactive,
    forceDns: options.forceDns,
    seams: options.reconcile,
  });
  await activate({ client, appId: manifest.id, sleep: options.sleep });

  // The gateway reaches the app over the binding just made, so the tools
  // snapshot comes once the app is active. It never throws: the app is
  // already live.
  await syncAppToolsWithGateway({
    gatewayUrl,
    appId: manifest.id,
    mcpUrl: `https://${registration.hostname}/mcp`,
    out,
    verbose: options.verbose,
    client,
  });

  if (published.includes(registration.hostname)) {
    if (options.waitForCertificate ?? true) {
      await waitForCertificates({
        hosts: [registration.hostname],
        out,
        step: "app.tls",
        ...options.certificates,
      });
    } else {
      out.emit({
        type: "progress",
        step: "app.tls",
        message: `https://${registration.hostname} gets its certificate within a few minutes; \`everyapp gateway status\` shows when.`,
      });
    }
  }
  out.emit({
    type: "step",
    step: "app.live",
    status: "ok",
    message: `${manifest.id} is live at https://${registration.hostname}.`,
    data: {
      hostname: registration.hostname,
      url: `https://${registration.hostname}`,
    },
  });

  return {
    liveUrl: `https://${registration.hostname}`,
    gatewayUrl,
    organizationId: whoami.organizationId,
    hostname: registration.hostname,
    workerName: registration.workerName,
    versionId,
  };
}

/**
 * The deploy token's organization and the gateway's Cloudflare account,
 * with cf logged in and pinned to that account: app deploys always run in
 * the gateway's own account.
 */
export async function connectToGatewayAccount({
  client,
  interactive,
  createCf,
}: {
  client: GatewayClient;
  interactive: boolean;
  createCf: (accountId?: string) => CfRunner;
}): Promise<{
  whoami: GatewayWhoamiResponse;
  accountId: string;
  cf: CfRunner;
  gatewayDb: string;
}> {
  const whoami = await gatewayCall(() => client.whoami());
  const accountId = checkGateway(whoami);
  const cfLogin = await ensureCfAuth({ cf: createCf(), interactive });
  if (
    cfLogin.accounts?.length &&
    !cfLogin.accounts.some((account) => account.id === accountId)
  ) {
    throw new EveryAppError(
      "ACCOUNT_MISMATCH",
      `The gateway runs in Cloudflare account ${accountId}, which cf${cfLogin.email ? ` (logged in as ${cfLogin.email})` : ""} can't use. Log in to that account: npx cf auth login`,
    );
  }
  const cf = createCf(accountId);
  const gatewayDb = await findGatewayDatabase(cf);
  if (!gatewayDb) {
    throw new EveryAppError(
      "ACCOUNT_MISMATCH",
      `Cloudflare account ${accountId} has no gateway database; is cf logged in to the gateway's account?`,
    );
  }
  return { whoami, accountId, cf, gatewayDb };
}

/** The gateway's Cloudflare account, once it speaks this deploy protocol. */
function checkGateway(whoami: GatewayWhoamiResponse): string {
  if ((whoami.capabilities?.deployProtocol ?? 1) < 2) {
    throw new EveryAppError(
      "GATEWAY_OUTDATED",
      "The gateway is too old for this everyapp. Upgrade it first: everyapp gateway upgrade",
      { rerun: `${CLI} gateway upgrade` },
    );
  }
  if (whoami.minCli && compareVersions(cliVersion, whoami.minCli) < 0) {
    throw new EveryAppError(
      "CLI_TOO_OLD",
      `This gateway needs everyapp ${whoami.minCli} or newer; this is ${cliVersion}.`,
    );
  }
  if (!whoami.accountId) {
    throw new EveryAppError(
      "GATEWAY_ACCOUNT_UNKNOWN",
      "The gateway doesn't say which Cloudflare account it runs in. Redeploy it: everyapp gateway upgrade",
      { rerun: `${CLI} gateway upgrade` },
    );
  }
  return whoami.accountId;
}

export async function gatewayCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw explainGatewayError(error);
  }
}

/** Durable Object classes the last deploy had and this one drops. */
function checkDurableObjects(
  registration: RegisterAppResponse,
  manifest: EveryAppCliManifest,
  allowDelete: boolean,
): string[] {
  const previous = registration.previousManifest as {
    resources?: { durableObjects?: Array<{ className?: unknown }> };
  } | null;
  const current = new Set(
    (manifest.resources?.durableObjects ?? []).map((d) => d.className),
  );
  const removed = (previous?.resources?.durableObjects ?? [])
    .map((d) => String(d.className))
    .filter((className) => !current.has(className));
  if (removed.length > 0 && !allowDelete) {
    throw new EveryAppError(
      "DURABLE_OBJECT_REMOVED",
      `everyapp.config.ts no longer declares the Durable Object class${removed.length === 1 ? "" : "es"} ${removed.join(", ")}. Deploying deletes ${removed.length === 1 ? "its" : "their"} data for good; pass --allow-delete-durable-object-data if that's what you want.`,
    );
  }
  return removed;
}

/**
 * Workflows the last deploy had that this one drops, among those that run
 * on the app's Worker: like a Durable Object class, deleting one deletes
 * its instances, so only with --allow-delete-workflows.
 */
async function checkWorkflows({
  cf,
  registration,
  manifest,
  allowDelete,
}: {
  cf: CfRunner;
  registration: RegisterAppResponse;
  manifest: EveryAppCliManifest;
  allowDelete: boolean;
}): Promise<AppWorkflow[]> {
  const removed = await droppedWorkflows({
    cf,
    workerName: registration.workerName,
    previousManifest: registration.previousManifest,
    names: appWorkflows(registration.workerName, manifest).map(
      (workflow) => workflow.name,
    ),
  });
  if (removed.length > 0 && !allowDelete) {
    const one = removed.length === 1;
    throw new EveryAppError(
      "WORKFLOW_REMOVED",
      `everyapp.config.ts no longer declares the Workflow${one ? "" : "s"} ${removed.map((workflow) => workflow.binding).join(", ")} (renaming a binding renames its Workflow). Deploying deletes ${one ? "it" : "them"} with ${one ? "its" : "their"} instances for good; pass --allow-delete-workflows if that's what you want.`,
    );
  }
  return removed;
}

/** Returns the command that rolls the database back, when it changed. */
async function migrate({
  cf,
  out,
  cwd,
  manifest,
  resources,
  accountId,
}: {
  cf: CfRunner;
  out: EventSink;
  cwd: string;
  manifest: EveryAppCliManifest;
  resources: DeployInputs["resources"];
  accountId: string;
}): Promise<string | null> {
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length === 0) return null;
  const binding = resolveMigrationBinding(bindings, manifest.migrations);
  const databaseId = resources.d1?.[binding]?.id;
  const dir = path.resolve(cwd, manifest.migrations?.dir ?? "drizzle");
  if (!databaseId || !(await isDirectory(dir))) {
    out.emit({
      type: "step",
      step: "app.migrations",
      status: "skip",
      message: "No migrations to apply.",
    });
    return null;
  }
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "start",
    message: "Migrating the app's database...",
  });
  const result = await migrateRemoteD1({
    cf,
    databaseId,
    accountId,
    dir,
    onProgress: (message) =>
      out.emit({ type: "progress", step: "app.migrations", message }),
  });
  const changed = result.applied.length > 0;
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "ok",
    message: changed
      ? `Applied ${result.applied.join(", ")}. To roll the database back to before this run: ${result.rollbackCommand}`
      : "The app's database is up to date.",
    data: {
      bookmark: result.bookmark,
      applied: result.applied,
      rollbackCommand: result.rollbackCommand,
    },
  });
  return changed ? result.rollbackCommand : null;
}

/**
 * Reconcile the gateway when it doesn't bind this app's Worker yet, or
 * doesn't publish its hostname yet. Returns the hostnames that reconcile
 * published for the first time.
 */
async function bindIfNeeded({
  client,
  cf,
  out,
  accountId,
  workerName,
  publishHost,
  interactive,
  forceDns,
  seams,
}: {
  client: GatewayClient;
  cf: CfRunner;
  out: EventSink;
  accountId: string;
  workerName: string;
  /** The app's hostname isn't one of the gateway's Custom Domains yet. */
  publishHost: boolean;
  interactive: boolean;
  forceDns?: boolean;
  seams?: ReconcileSeams;
}): Promise<string[]> {
  const live = await client.status({ auth: true }).catch(() => null);
  if (live?.appBindings?.includes(workerName) && !publishHost) return [];
  out.emit({
    type: "step",
    step: "app.bind",
    status: "start",
    message: `Binding ${appBindingName(workerName)} on the gateway${publishHost ? " and publishing its hostname" : ""}...`,
  });
  try {
    const result = await reconcileGateway({
      cf,
      out,
      accountId,
      interactive,
      cliVersion,
      force: true,
      forceDns,
      ...seams,
    });
    out.emit({
      type: "step",
      step: "app.bind",
      status: "ok",
      message: `The gateway binds ${appBindingName(workerName)} (gateway version ${result.versionId ?? "unknown"}).`,
      data: { versionId: result.versionId, newHosts: result.newHosts },
    });
    return result.newHosts;
  } catch (error) {
    if (error instanceof EveryAppError && error.code === "LEASE_HELD") {
      throw new EveryAppError(
        "LEASE_HELD",
        `${error.message} This app's upload is kept: run \`everyapp app deploy\` again once the gateway is free, and it binds the app and makes it live.`,
        { retryable: true },
      );
    }
    throw error;
  }
}

/** Activate, retrying while the gateway version with the binding rolls out. */
async function activate({
  client,
  appId,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  client: GatewayClient;
  appId: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + ACTIVATE_TIMEOUT_MS;
  for (;;) {
    try {
      await client.activateApp(appId);
      return;
    } catch (error) {
      const notReady =
        error instanceof GatewayApiError && error.code === "BINDING_NOT_READY";
      if (!notReady) throw explainGatewayError(error);
      if (Date.now() >= deadline) {
        throw new EveryAppError(
          "BINDING_NOT_READY",
          `The gateway still can't reach ${appId}'s Worker. Run \`everyapp gateway status\`, then \`everyapp app deploy\` again; the upload is kept.`,
          { retryable: true },
        );
      }
      await sleep(ACTIVATE_INTERVAL_MS);
    }
  }
}

async function installedSdkVersion(cwd: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(cwd, "node_modules", "@every-app", "sdk", "package.json"),
        "utf8",
      ),
    ) as { version?: string };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
