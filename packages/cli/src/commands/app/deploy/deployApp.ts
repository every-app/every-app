/**
 * Deploying an app, shared by `everyapp app deploy` and `app create`:
 *
 *   1. ask the gateway who we deploy as, and in which Cloudflare account;
 *   2. register: the gateway assigns the Worker, resource and host names
 *      (a new app starts `pending`, unbound);
 *   3. under the app's deploy lease: find or create its D1 and KV (only
 *      ever the app's own), `cf build` with the deploy inputs and check the
 *      built Worker against the app policy, make sure an unattended run may
 *      replace the Worker, and only then migrate D1 (bookmark, drizzle
 *      history carried over once, `cf d1 migrations apply`) and upload it
 *      (`cf deploy --prebuilt`, with GATEWAY_URL and EVERY_APP_ORG_ID in
 *      the secrets file), so a deploy that can't upload leaves the database
 *      alone;
 *   4. tell the gateway the version is up (`pending` → `binding`), have the
 *      gateway bind the Worker if it doesn't yet (a reconcile of the live
 *      gateway release), and activate once the binding answers.
 *
 * A redeploy of an app the gateway already binds never touches the gateway.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { version as cliVersion } from "../../../../package.json";
import { appBindingName } from "@every-app/perimeter/manifest";
import { buildApp } from "@/lib/app/buildApp";
import {
  MISSING_CLOUDFLARE_CONFIG,
  readCloudflareConfig,
} from "@/lib/app/cloudflareConfig";
import type { DeployInputs } from "@/lib/app/deployInputs";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { readOwnedResources, recordUploadedVersion } from "@/lib/app/ownership";
import { claimAppWorker, provisionAppResources } from "@/lib/app/resources";
import { ensureCfAuth } from "@/lib/cf/account";
import { cfD1Database } from "@/lib/cf/d1";
import {
  assertReplaceable,
  canPromptInTerminal,
  cfDeploy,
  type Confirm,
} from "@/lib/cf/deploy";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { resolvesThroughCloudflare } from "@/lib/dns";
import { formatWildcardDnsInstructions } from "@/lib/dnsInstructions";
import { EveryAppError } from "@/lib/errors";
import {
  explainGatewayError,
  GatewayApiError,
  GatewayClient,
  type GatewayStatusResponse,
  type GatewayWhoamiResponse,
  type RegisterAppResponse,
} from "@/lib/gateway/api";
import { acquireLease, type BreakLease } from "@/lib/gateway/lease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { bundledReleaseTarball, compareVersions } from "@/lib/gateway/release";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import {
  loadEveryAppManifest,
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import { migrateRemoteD1, readDrizzleJournal } from "@/lib/migrations/remote";
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
  /** Asked whether to take the app's lease from a deploy that holds it (`--break-lease`). */
  breakLease?: BreakLease;
  /** Seams for tests. */
  interactive?: boolean;
  confirm?: Confirm;
  createCf?: (accountId?: string) => CfRunner;
  client?: GatewayClient;
  sleep?: (ms: number) => Promise<void>;
  checkDns?: (hostname: string) => Promise<boolean>;
  installDeps?: typeof installDependencies;
  reconcile?: ReconcileSeams;
}

/** How a reconcile reads the live gateway, and how long it waits (tests). */
export interface ReconcileSeams {
  readStatus?: (gatewayUrl: string) => Promise<GatewayStatusResponse>;
  sleep?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  leaseWaitMs?: number;
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
  const { cwd, out, gatewayUrl } = options;
  const createCf = options.createCf ?? ((accountId?: string) => createCfRunner({ accountId }));
  const client = options.client ?? new GatewayClient({ gatewayUrl });
  const interactive =
    options.interactive ?? canPromptInTerminal(options.json ?? false);

  const manifest = options.manifest ?? (await loadEveryAppManifest(cwd));
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
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${registration.existingApp ? "Updating" : "Registered"} ${manifest.id} as ${registration.workerName} (${registration.status}).`,
    data: {
      workerName: registration.workerName,
      hostname: registration.hostname,
      status: registration.status,
    },
  });
  if (!registration.existingApp && !registration.defaultAccess) {
    out.emit({
      type: "progress",
      step: "app.register",
      message:
        "New apps are private: only you and the organization's owners and admins can open it. Grant others in Admin → Apps, or deploy with --access everyone.",
    });
  }

  // 3. Everything that touches the app's Worker and data, one deploy at a time.
  const registry = cfD1Database(cf, gatewayDb);
  const lease = await acquireLease({
    db: registry,
    id: `app:${registration.workerName}`,
    purpose: "app.deploy",
    breakLease: options.breakLease,
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
    // Only what this app created (and recorded as its own) is used; a
    // name that's taken by anything else is refused, on every attempt.
    const ownership = {
      cf,
      gatewayDb: registry,
      registration,
      onCreated: (description: string) =>
        out.emit({ type: "progress", step: "app.resources", message: `Created ${description}.` }),
      onAdopted: (description: string) =>
        out.emit({
          type: "progress",
          step: "app.resources",
          message: `Recorded ${description}, which ${manifest.id} already used, as its own.`,
        }),
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
      env: {
        VITE_GATEWAY_URL: gatewayUrl,
        VITE_APP_ID: manifest.id,
        EVERYAPP_GATEWAY_URL: gatewayUrl,
        EVERYAPP_APP_ID: manifest.id,
      },
      verbose: options.verbose ?? false,
    });
    await prepareAppBuildOutput({ cwd, inputs });

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
    await migrate({ cf, out, cwd, manifest, resources, accountId });

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
    await gatewayCall(() =>
      client.markDeployed(manifest.id, { versionId, manifest }),
    );
  } finally {
    await lease.release();
  }

  // 4. Bind and go live. --break-lease was about the app's lease: the
  // gateway's is waited for.
  await bindIfNeeded({
    client,
    cf,
    out,
    accountId,
    workerName: registration.workerName,
    interactive,
    seams: options.reconcile,
  });
  await activate({ client, appId: manifest.id, sleep: options.sleep });

  if (!(await (options.checkDns ?? resolvesThroughCloudflare)(registration.hostname))) {
    out.emit({
      type: "warning",
      code: "WILDCARD_DNS_MISSING",
      message: formatWildcardDnsInstructions({
        domain: registration.hostname.split(".").slice(1).join("."),
        accountId,
        mode: "app",
        hostname: registration.hostname,
      }),
    });
  }

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
      "The gateway is too old for this everyapp. Upgrade it first: npx everyapp gateway upgrade",
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
      "The gateway doesn't say which Cloudflare account it runs in. Redeploy it: npx everyapp gateway upgrade",
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
}): Promise<void> {
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length === 0) return;
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
    return;
  }
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "start",
    message: "Migrating the app's database...",
  });
  const engine = manifest.migrations?.engine ?? "drizzle";
  const result = await migrateRemoteD1({
    cf,
    db: cfD1Database(cf, databaseId),
    databaseId,
    accountId,
    dir,
    // drizzle-kit migrated apps before cf did; d1-sql apps were already
    // tracked in d1_migrations.
    journal: engine === "drizzle" ? await readDrizzleJournal(dir) : undefined,
    onProgress: (message) =>
      out.emit({ type: "progress", step: "app.migrations", message }),
  });
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "ok",
    message:
      result.applied.length > 0
        ? `Applied ${result.applied.join(", ")}.`
        : "The app's database is up to date.",
    data: { bookmark: result.bookmark, applied: result.applied },
  });
}

/** Reconcile the gateway when it doesn't bind this app's Worker yet. */
async function bindIfNeeded({
  client,
  cf,
  out,
  accountId,
  workerName,
  interactive,
  seams,
}: {
  client: GatewayClient;
  cf: CfRunner;
  out: EventSink;
  accountId: string;
  workerName: string;
  interactive: boolean;
  seams?: ReconcileSeams;
}): Promise<void> {
  const live = await client.status({ auth: true }).catch(() => null);
  if (live?.appBindings?.includes(workerName)) return;
  out.emit({
    type: "step",
    step: "app.bind",
    status: "start",
    message: `Binding ${appBindingName(workerName)} on the gateway...`,
  });
  try {
    await reconcileGateway({
      cf,
      out,
      accountId,
      interactive,
      cliVersion,
      force: true,
      bundledTarball: bundledReleaseTarball(),
      ...seams,
    });
  } catch (error) {
    if (error instanceof EveryAppError && error.code === "LEASE_HELD") {
      throw new EveryAppError(
        "LEASE_HELD",
        `${error.message} The upload is kept, and \`everyapp app deploy\` binds it once the gateway is free. Its --break-lease takes over only the app's lease: if that gateway deploy died, \`everyapp gateway reconcile --break-lease\` takes over the gateway's and binds the app; then run \`everyapp app deploy\` again to make it live.`,
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
