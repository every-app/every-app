/**
 * Deploying an app, shared by `everyapp app deploy` and `app create`:
 *
 *   1. find the gateway through the Cloudflare login: its D1 database and
 *      install row, in its account (lib/gateway/connect.ts);
 *   2. register the app in the gateway's D1 (lib/gateway/registry.ts, with
 *      the rules in @every-app/perimeter/registry): its Worker, resource
 *      and host names, and for a new app (`pending`, unbound) who can open
 *      it;
 *   3. under the app's deploy lease: find or create its D1 and KV (only
 *      ever the app's own), `cf build` with the deploy inputs (the
 *      gateway's identity key from the install row) and check the built
 *      Worker against the app policy and its Workflows' names (each new or
 *      already the app's), check that its drizzle migrations still describe
 *      its schema (steps/checkSchemaDrift.ts), make sure an unattended run
 *      may replace the Worker, and only then (the lease checked again
 *      before each) migrate D1 (bookmark, then `cf d1 migrations apply`)
 *      and upload it (`cf deploy --prebuilt`, with GATEWAY_URL and
 *      EVERY_APP_ORG_ID in the secrets file; cf creates or updates its
 *      Workflows), so a deploy that can't upload leaves the database alone.
 *      Workflows the app dropped (with --allow-delete-workflows) go once
 *      the upload is live; then the registry records the version, its
 *      manifest and who deployed it (`pending` → `binding`);
 *   4. bind the Worker on the gateway and publish the app's hostname as a
 *      Workers Custom Domain if the install row says it doesn't yet (a
 *      reconcile of the live gateway release), then wait for the app to go
 *      live: the gateway activates it on the first request that reaches it
 *      (steps/waitForLive.ts).
 *
 * A new hostname is checked (DNS records that answer it, the zone's room)
 * right after registering, before anything is created or uploaded.
 * A redeploy of an app the gateway already binds and serves never touches
 * the gateway. The gateway takes the app's agent tools itself, on first use
 * and whenever the app's version changes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { version as cliVersion } from "../../../../package.json";
import { appBindingName } from "@every-app/perimeter/manifest";
import type { RegistrationPlan } from "@every-app/perimeter/registry";
import { checkSchemaDrift } from "@/commands/app/deploy/steps/checkSchemaDrift";
import {
  waitForLive,
  type LiveWaitSeams,
} from "@/commands/app/deploy/steps/waitForLive";
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
import type { D1Database } from "@/lib/cf/d1";
import {
  assertReplaceable,
  canPromptInTerminal,
  cfDeploy,
  type Confirm,
} from "@/lib/cf/deploy";
import { CfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorkflow } from "@/lib/cf/workflows";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { preflightDomains } from "@/lib/domains/preflight";
import { afterMigration, EveryAppError } from "@/lib/errors";
import { connectToGateway } from "@/lib/gateway/connect";
import { readInstall } from "@/lib/gateway/install";
import { acquireLease } from "@/lib/gateway/lease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { markDeployed, register } from "@/lib/gateway/registry";
import {
  loadEveryAppManifest,
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import { migrateRemoteD1 } from "@/lib/migrations/remote";
import type { EventSink } from "@/lib/output/events";
import { installDependencies } from "@/lib/package-manager";

interface DeployAppOptions {
  cwd: string;
  manifest?: EveryAppCliManifest;
  /** The gateway `--gateway` or EVERYAPP_GATEWAY_URL names, checked against the install. */
  gateway?: string;
  out: EventSink;
  json?: boolean;
  verbose?: boolean;
  allowDeleteDurableObjectData?: boolean;
  /** Delete the Workflows the app dropped, with their instances (`--allow-delete-workflows`). */
  allowDeleteWorkflows?: boolean;
  /** Publish a new hostname over the DNS record that answers it (`--force-dns`). */
  forceDns?: boolean;
  /**
   * Wait for the app to go live, its new hostname's certificate included
   * (default true; `--no-wait-cert`). Without the wait, it goes live on its
   * first visit.
   */
  waitForLive?: boolean;
  /**
   * The app's own secrets to send with this version (`app secret set`).
   * They stay on the Worker through later deploys, which don't send them.
   */
  secrets?: Record<string, string>;
  /** Seams for tests. */
  interactive?: boolean;
  confirm?: Confirm;
  createCf?: (accountId?: string) => CfRunner;
  installDeps?: typeof installDependencies;
  reconcile?: ReconcileSeams;
  live?: LiveWaitSeams;
}

/** How long a reconcile waits for the gateway's lease, and how it sleeps (tests). */
export interface ReconcileSeams {
  sleep?: (ms: number) => Promise<void>;
  leaseWaitMs?: number;
}

interface DeployAppResult {
  liveUrl: string;
  gatewayUrl: string;
  organizationId: string;
  hostname: string;
  workerName: string;
  versionId: string;
  /** The registry says the app is active (it can also go live on its first visit). */
  live: boolean;
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
  const { cwd, out } = options;
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

  // 1. The gateway, through the Cloudflare login: its account, D1 and install.
  const { cf, accountId, accountName, db: registry, install, gatewayUrl, deployer } =
    await connectToGateway({
      gateway: options.gateway,
      interactive,
      createCf: options.createCf,
    });
  const identityKey = install.jwtPublicKey;
  if (!identityKey) {
    throw new EveryAppError(
      "IDENTITY_KEY_UNKNOWN",
      "The gateway's install row has no identity public key, which app Workers need to verify who is signed in. Write the gateway's JWT_PUBLIC_KEY into it as docs/runbooks/key-rotation.md shows, then deploy again.",
    );
  }

  // 2. Register: the rules name everything.
  const { plan, organization, hasOwner, deployerGranted } = await register(registry, {
    appSlug: manifest.id,
    name: manifest.name ?? manifest.id,
    description: manifest.description ?? manifest.id,
    manifest,
    appBaseDomain: install.appBaseDomain,
    deployer,
    organizationName: accountName ?? "",
  });
  const hostname = plan.app.hostname!;
  const workerName = plan.app.workerName!;
  const isNew = plan.kind !== "existing";
  // A person's first line: where this goes, and (secret set) what for. A
  // new app's says who can open it.
  const secretNames = Object.keys(options.secrets ?? {});
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${isNew ? "Registered" : "Updating"} ${manifest.id} as ${workerName} at https://${hostname} (${plan.app.status}).${
      !isNew
        ? ""
        : plan.app.isDefault
          ? " Everyone in the organization can open it."
          : ` New apps are private: only ${deployerGranted ? "you and " : ""}the organization's owners and admins can open it. Grant others in Admin → Apps.`
    }${isNew && !hasOwner ? " The gateway has no owner yet: its first owner gets the app (everyapp setup)." : ""}`,
    data: {
      appId: manifest.id,
      workerName,
      hostname,
      status: plan.app.status,
      existingApp: !isNew,
      defaultAccess: plan.app.isDefault,
      deployerAccess: deployerGranted,
      organizationId: organization.id,
      organizationName: organization.name,
      ...(secretNames.length > 0 ? { secrets: secretNames } : {}),
    },
  });

  // A hostname the gateway doesn't serve yet is checked before anything is
  // created or uploaded; the reconcile that publishes it checks again. One
  // that isn't one label below the base is never published, so it is
  // neither checked nor a reason to redeploy the gateway.
  const outsideBase = !isOneLabelBelow(hostname, install.appBaseDomain);
  const newHost = !outsideBase && !install.liveDomains.includes(hostname);
  if (outsideBase) {
    out.emit({
      type: "warning",
      code: "APP_HOST_OUTSIDE_BASE",
      step: "app.domain",
      message: `${hostname} isn't one label below ${install.appBaseDomain}, so the gateway doesn't publish it and ${manifest.id} can't be reached there.`,
    });
  }
  if (newHost) {
    await preflightDomains({
      cf,
      out,
      step: "app.domain",
      zone: { id: install.zoneId, name: install.zoneName },
      domains: [...install.liveDomains, hostname],
      liveDomains: install.liveDomains,
      forceDns: options.forceDns,
      interactive,
    });
  }

  // 3. Everything that touches the app's Worker and data, one deploy at a time.
  const lease = await acquireLease({
    db: registry,
    id: `app:${workerName}`,
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
      plan,
      manifest,
      options.allowDeleteDurableObjectData ?? false,
    );
    const deletedWorkflows = await checkWorkflows({
      cf,
      plan,
      workerName,
      manifest,
      allowDelete: options.allowDeleteWorkflows ?? false,
    });
    // Only what this app created (and recorded as its own) is used; a
    // name that's taken by anything else is refused, on every attempt.
    const ownership = {
      cf,
      gatewayDb: registry,
      registration: { workerName, resources: plan.resources },
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

    const inputs: DeployInputs = {
      workerName,
      organizationId: organization.id,
      gatewayUrl,
      identityIssuer: gatewayUrl,
      identityPublicKeys: [identityKey],
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
    await assertOwnWorkflows({ cf, workerName, names: workflows });
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
    const workerRecord = (await readOwnedResources(registry, workerName)).find(
      (resource) => resource.kind === "worker",
    );
    await assertReplaceable({
      cf,
      workerName,
      recordedVersionIds: [plan.versionId, workerRecord?.versionId],
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
      message: `Uploading ${workerName}...`,
    });
    const uploaded = await cfDeploy({
      cf,
      cwd,
      workerName,
      accountId,
      message: `everyapp ${cliVersion} ${manifest.id}`,
      secrets: {
        ...options.secrets,
        GATEWAY_URL: gatewayUrl,
        EVERY_APP_ORG_ID: organization.id,
      },
      interactive,
      // Recorded at once, before the registry hears of it: a retry must
      // find this upload was everyapp's, however this run ends.
      onUploaded: (uploadedVersion) =>
        recordUploadedVersion(registry, workerName, uploadedVersion),
    });
    if (!uploaded.versionId) {
      throw new EveryAppError(
        "VERSION_UNKNOWN",
        `cf deployed ${workerName}, but Cloudflare reports no version for it.`,
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
    // The live version no longer defines them. Before the registry records
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
    await markDeployed(registry, plan.app.id, {
      versionId,
      manifest,
      actor: deployer.actor,
    });
  } finally {
    await lease.release();
  }

  // 4. Bind and publish under the gateway's lease, then go live.
  await bindIfNeeded({
    cf,
    db: registry,
    out,
    accountId,
    workerName,
    publishHost: newHost,
    interactive,
    forceDns: options.forceDns,
    seams: options.reconcile,
  });
  // A hostname the gateway doesn't publish never answers (warned above).
  const wait = !outsideBase && (options.waitForLive ?? true);
  if (!outsideBase && !wait) {
    out.emit({
      type: "progress",
      step: "app.live",
      message: `${manifest.id} goes live on its first visit to https://${hostname}${newHost ? ", once its certificate comes (within a few minutes)" : ""}; \`everyapp gateway status\` shows it.`,
      data: { hostname },
    });
  }
  const live =
    wait &&
    (await waitForLive({
      db: registry,
      appRowId: plan.app.id,
      appId: manifest.id,
      hostname,
      out,
      newHostname: newHost,
      ...options.live,
    })) === "live";
  if (live) {
    out.emit({
      type: "step",
      step: "app.live",
      status: "ok",
      message: `${manifest.id} is live at https://${hostname}.`,
      data: { hostname, url: `https://${hostname}` },
    });
  }

  return {
    liveUrl: `https://${hostname}`,
    gatewayUrl,
    organizationId: organization.id,
    hostname,
    workerName,
    versionId,
    live,
  };
}

/** Durable Object classes the last deploy had and this one drops. */
function checkDurableObjects(
  plan: RegistrationPlan,
  manifest: EveryAppCliManifest,
  allowDelete: boolean,
): string[] {
  const current = new Set(
    (manifest.resources?.durableObjects ?? []).map((d) => d.className),
  );
  const removed = (plan.previousManifest?.resources?.durableObjects ?? [])
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
  plan,
  workerName,
  manifest,
  allowDelete,
}: {
  cf: CfRunner;
  plan: RegistrationPlan;
  workerName: string;
  manifest: EveryAppCliManifest;
  allowDelete: boolean;
}): Promise<AppWorkflow[]> {
  const removed = await droppedWorkflows({
    cf,
    workerName,
    previousManifest: plan.previousManifest,
    names: appWorkflows(workerName, manifest).map((workflow) => workflow.name),
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
 * Reconcile the gateway when the install row says it doesn't bind this
 * app's Worker yet, or doesn't publish its hostname yet.
 */
async function bindIfNeeded({
  cf,
  db,
  out,
  accountId,
  workerName,
  publishHost,
  interactive,
  forceDns,
  seams,
}: {
  cf: CfRunner;
  db: D1Database;
  out: EventSink;
  accountId: string;
  workerName: string;
  /** The app's hostname isn't one of the gateway's Custom Domains yet. */
  publishHost: boolean;
  interactive: boolean;
  forceDns?: boolean;
  seams?: ReconcileSeams;
}): Promise<void> {
  const install = await readInstall(db);
  if (install?.liveAppWorkers.includes(workerName) && !publishHost) return;
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

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
