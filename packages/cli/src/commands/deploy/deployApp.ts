/**
 * Deploying an app, shared by `everyapp deploy`, `secret set|unset` and
 * `create --deploy`:
 *
 *   1. find the gateway through the Cloudflare login: its D1 database and
 *      install row, in its account (lib/gateway/connect.ts); with none in
 *      any account, `deploy` offers to install one (steps/offerGateway.ts);
 *   2. register the app in the gateway's D1 (lib/gateway/registry.ts, with
 *      the rules in @every-app/perimeter/registry): its Worker, resource
 *      and host names, and for a new app (`pending`, unbound) who can open
 *      it;
 *   3. under the app's deploy lease: find or create its D1, KV and
 *      Hyperdrive configs (only ever the app's own; a config from the
 *      origin in the app's secrets file, lib/app/deploySecrets.ts, with
 *      query caching off unless the manifest says otherwise), name its R2
 *      buckets (left to `cf deploy` to create), `cf build` with the
 *      deploy inputs (the gateway's identity key from the install row) and
 *      check the built Worker against the app policy and its Workflows'
 *      names (each new or already the app's), check that its drizzle
 *      migrations still describe its schema (steps/checkSchemaDrift.ts),
 *      make sure an unattended run may replace the Worker, and only then
 *      (the lease checked again before each) migrate D1 (bookmark, then
 *      `cf d1 migrations apply`),
 *      or Postgres (`drizzle-kit migrate`, lib/migrations/postgres.ts, or
 *      `prisma migrate deploy`, lib/migrations/prisma.ts), and upload it
 *      (`cf deploy --prebuilt`, with GATEWAY_URL and EVERY_APP_ORG_ID in
 *      the secrets file; cf creates or updates its Workflows), so a
 *      deploy that can't upload leaves the database alone.
 *      Workflows the app dropped (with --allow-delete-workflows) go once
 *      the upload is live, and its Email Routing routes (`email.inbound`,
 *      lib/app/emailRoutes.ts: checked before anything is created, Email
 *      Routing turned on for a domain only at a terminal or with
 *      --enable-email-routing) are made; then the registry records the
 *      version, its manifest and who deployed it (`pending` → `binding`). The app's
 *      helper Workers (`workers`, `<worker>--<name>`) are claimed, checked
 *      and recorded like its Worker, and uploaded before it, since it binds
 *      them;
 *   4. bind the Worker on the gateway and publish the app's hostname as a
 *      Workers Custom Domain if the install row says it doesn't yet (a
 *      reconcile: the gateway this checkout builds, from the build cache
 *      when it can, which also upgrades a gateway older than the checkout),
 *      then wait for the app to go live: the gateway activates it on the
 *      first request that reaches it (steps/waitForLive.ts).
 *
 * With `shared` (`--shared`, the hosted gateway's first-party apps) the app
 * registers as one Worker every organization's members may open, owned by
 * the platform organization; its Worker gets no EVERY_APP_ORG_ID. A
 * redeploy without it (`secret set|unset` too) keeps the app's scope.
 *
 * A new hostname is checked (DNS records that answer it, the zone's room)
 * right after registering, before anything is created or uploaded.
 * A redeploy of an app the gateway already binds and serves never touches
 * the gateway. The gateway takes the app's agent tools itself, on first use
 * and whenever the app's version changes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { version as cliVersion } from "../../../package.json";
import {
  appBindingName,
  manifestTierProblems,
} from "@every-app/perimeter/manifest";
import type { RegistrationPlan } from "@every-app/perimeter/registry";
import { helperWorkerName } from "@every-app/sdk/cloudflare";
import { setupDeps, type SetupDeps } from "@/commands/setup/runSetup";
import { checkSchemaDrift } from "./steps/checkSchemaDrift";
import { offerGateway } from "./steps/offerGateway";
import { waitForLive, type LiveWaitSeams } from "./steps/waitForLive";
import { buildApp } from "@/lib/app/buildApp";
import {
  MISSING_CLOUDFLARE_CONFIG,
  readCloudflareConfig,
} from "@/lib/app/cloudflareConfig";
import type { DeployInputs } from "@/lib/app/deployInputs";
import {
  APP_SECRETS_FILE,
  POSTGRES_URL_VARIABLE,
  readAppSecrets,
  type AppSecrets,
} from "@/lib/app/deploySecrets";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { assertAppSecretName } from "@/lib/app/secrets";
import { readOwnedResources, recordUploadedVersion } from "@/lib/app/ownership";
import { claimAppWorker, provisionAppResources } from "@/lib/app/resources";
import { applyEmailRoutes, planEmailRoutes } from "@/lib/app/emailRoutes";
import {
  appWorkflows,
  assertOwnWorkflows,
  droppedWorkflows,
  type AppWorkflow,
} from "@/lib/app/workflows";
import { deviceLoginAction } from "@/lib/cf/account";
import type { D1Database } from "@/lib/cf/d1";
import {
  assertReplaceable,
  canPromptInTerminal,
  cfDeploy,
  type Confirm,
} from "@/lib/cf/deploy";
import { CfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorkerSecret } from "@/lib/cf/secrets";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { deleteWorkflow } from "@/lib/cf/workflows";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { preflightDomains } from "@/lib/domains/preflight";
import { afterMigration, EveryAppError } from "@/lib/errors";
import { connectToGateway } from "@/lib/gateway/connect";
import { checkoutRoot } from "@/lib/checkout";
import { refuseOlderCheckout } from "@/lib/gateway/apply";
import {
  checkoutSource,
  openGatewayRelease,
  type CheckoutSource,
} from "@/lib/gateway/checkoutRelease";
import { readInstall } from "@/lib/gateway/install";
import { acquireLease } from "@/lib/gateway/lease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import type { GatewayRelease } from "@/lib/gateway/release";
import { markDeployed, register } from "@/lib/gateway/registry";
import type { InstallRecord } from "@/lib/gateway/install";
import {
  loadEveryAppManifest,
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import { migratePostgres, type DrizzleKitRunner } from "@/lib/migrations/postgres";
import { migratePrismaPostgres, type PrismaRunner } from "@/lib/migrations/prisma";
import { migrateRemoteD1 } from "@/lib/migrations/remote";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { installDependencies } from "@/lib/package-manager";

interface DeployAppOptions {
  cwd: string;
  manifest?: EveryAppCliManifest;
  /** The gateway `--gateway` or EVERYAPP_GATEWAY_URL names, checked against the install. */
  gateway?: string;
  /** The Gateway's Cloudflare account (`--account-id`), when the login sees several. */
  accountId?: string;
  out: EventSink;
  json?: boolean;
  verbose?: boolean;
  allowDeleteDurableObjectData?: boolean;
  /** Delete the Workflows the app dropped, with their instances (`--allow-delete-workflows`). */
  allowDeleteWorkflows?: boolean;
  /** Publish a new hostname over the DNS record that answers it (`--force-dns`). */
  forceDns?: boolean;
  /**
   * Turn Email Routing on for the domains `email.inbound` names that don't
   * route mail yet, without asking (`--enable-email-routing`).
   */
  enableEmailRouting?: boolean;
  /**
   * Register a shared app (`--shared`): hosted gateways only, by the
   * platform organization's owners and admins. Unset, a registered app
   * keeps its scope and a new one is the organization's own.
   */
  shared?: boolean;
  /**
   * Wait for the app to go live, its new hostname's certificate included
   * (default true; `--no-wait`). Without the wait, it goes live on its
   * first visit.
   */
  waitForLive?: boolean;
  /**
   * The app's own secrets to send with this version (`secret set`). They
   * stay on the Worker through later deploys, which don't send them.
   */
  secrets?: Record<string, string>;
  /**
   * Secrets to delete from the Worker before this version goes up
   * (`secret unset`): Cloudflare drops them from a new version of the live
   * one, which this deploy then replaces as everyapp's own.
   */
  unsetSecrets?: readonly string[];
  /**
   * With no Gateway in any account the login sees, offer to install one
   * (`deploy`, `create --deploy`): at a terminal setup's pipeline runs
   * first, unattended the run stops with `install_gateway`. `yes` installs
   * at apps.<zone> without asking; `confirm` and `setup` are test seams.
   */
  offerInstall?: { yes?: boolean; confirm?: Confirm; setup?: Partial<SetupDeps> };
  /** Seams for tests. */
  interactive?: boolean;
  confirm?: Confirm;
  createCf?: (accountId?: string) => CfRunner;
  installDeps?: typeof installDependencies;
  /** Runs drizzle-kit for Postgres migrations (default: the app's own). */
  drizzleKit?: DrizzleKitRunner;
  /** Runs the Prisma CLI for migrations.engine "prisma" (default: the app's own). */
  prisma?: PrismaRunner;
  reconcile?: ReconcileSeams;
  live?: LiveWaitSeams;
}

/**
 * The rebind's seams (tests): how long it waits for the gateway's lease,
 * how it sleeps, and the release it deploys (default: the one this
 * checkout builds, from the build cache when it can).
 */
export interface ReconcileSeams {
  sleep?: (ms: number) => Promise<void>;
  leaseWaitMs?: number;
  openRelease?: () => Promise<GatewayRelease>;
  /** What this checkout's Gateway is, without building it. */
  source?: () => Promise<CheckoutSource>;
}

/** What this checkout's Gateway is, unless a test says. */
export function checkoutGateway(seams?: ReconcileSeams): () => Promise<CheckoutSource> {
  return seams?.source ?? (() => checkoutSource(checkoutRoot()));
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
    ...(manifest.resources?.r2 ?? []),
    ...(manifest.resources?.durableObjects ?? []).map((d) => d.name),
    ...(manifest.resources?.workflows ?? []).map((w) => w.name),
    ...(manifest.workers ?? []).flatMap((w) => (w.binding ? [w.binding] : [])),
    ...(manifest.resources?.hyperdrive ?? []).map((h) => h.name),
    ...(manifest.database ? ["DATABASE_PROVIDER"] : []),
    "ASSETS",
  ]);
  for (const name of options.unsetSecrets ?? []) assertAppSecretName(name);
  for (const name of Object.keys(options.secrets ?? {})) {
    assertAppSecretName(name);
    if (bindings.has(name)) {
      throw new EveryAppError(
        "SECRET_NAME_TAKEN",
        `${name} is one of ${manifest.id}'s bindings; pick another name for the secret.`,
      );
    }
  }
  // What reaches the app's Postgres database, checked before anything is created.
  const postgresMigrations = manifest.migrations?.dialect === "postgresql";
  const appSecrets: AppSecrets =
    postgresMigrations || manifest.resources?.hyperdrive?.length
      ? await readAppSecrets(cwd)
      : {};
  if (postgresMigrations && !appSecrets[POSTGRES_URL_VARIABLE]) {
    throw new EveryAppError(
      "POSTGRES_URL_MISSING",
      `${manifest.id} migrates a Postgres database, and the deploy needs its URL: set ${POSTGRES_URL_VARIABLE} in ${APP_SECRETS_FILE} to postgres://<user>:<password>@<host>:<port>/<database>, then deploy again.`,
    );
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

  // 1. The gateway, through the Cloudflare login: its account, D1 and
  // install. With none anywhere, `deploy` offers to install one first.
  const offer = options.offerInstall;
  const { cf, accountId, accountName, databaseId, db: registry, install, gatewayUrl, deployer } =
    await connectToGateway({
      gateway: options.gateway,
      accountId: options.accountId,
      interactive,
      // An agent reading --json gets cf's device login, and the run waits.
      onDeviceLogin: options.json ? deviceLoginAction(out, "app.login") : undefined,
      createCf: options.createCf,
      onNoGateway: offer
        ? ({ whoami, discovery }) =>
            offerGateway({
              whoami,
              discovery,
              out,
              offer: {
                accountId: options.accountId,
                yes: offer.yes,
                confirm: offer.confirm,
                forceDns: options.forceDns,
                verbose: options.verbose,
                deps: {
                  ...setupDeps({ out, json: options.json, verbose: options.verbose }),
                  interactive,
                  ...(options.createCf ? { createCf: options.createCf } : {}),
                  ...(options.reconcile?.openRelease
                    ? { openRelease: options.reconcile.openRelease }
                    : {}),
                  source: checkoutGateway(options.reconcile),
                  ...offer.setup,
                },
              },
            })
        : undefined,
    });
  // Before anything is registered: never with a checkout behind the Gateway.
  await refuseOlderCheckout(install, checkoutGateway(options.reconcile));
  const identityKey = install.jwtPublicKey;
  if (!identityKey) {
    throw new EveryAppError(
      "IDENTITY_KEY_UNKNOWN",
      "The gateway's install row has no identity public key, which app Workers need to verify who is signed in. Write the gateway's JWT_PUBLIC_KEY into it as docs/runbooks/key-rotation.md shows, then deploy again.",
    );
  }

  if (options.shared) assertSharedApps(install);

  // 2. Register: the rules name everything.
  const { plan, organization, hasOwner, deployerGranted } = await register(registry, {
    appSlug: manifest.id,
    name: manifest.name ?? manifest.id,
    description: manifest.description ?? manifest.id,
    manifest,
    appBaseDomain: install.appBaseDomain,
    deployer,
    organizationName: accountName ?? "",
    ...(options.shared ? { scope: "shared" as const } : {}),
  });
  const shared = plan.app.scope === "shared";
  // A redeploy that didn't ask keeps a shared app shared: still hosted only.
  if (shared) assertSharedApps(install);
  const hostname = plan.app.hostname!;
  const workerName = plan.app.workerName!;
  const isNew = plan.kind !== "existing";
  const tierProblems = manifestTierProblems(manifest, plan.app.tier);
  if (tierProblems.length > 0) {
    throw new EveryAppError(
      "TIER_POLICY",
      `${manifest.id} can't be deployed as it is: ${tierProblems.join("; ")}.`,
    );
  }
  // A person's first line: where this goes, and (secret set|unset) what
  // for. A new app's says who can open it.
  const secretNames = Object.keys(options.secrets ?? {});
  const unsetNames = [...(options.unsetSecrets ?? [])];
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${isNew ? "Registered" : "Updating"} ${manifest.id} as ${workerName} at https://${hostname} (${plan.app.status}).${
      !isNew
        ? ""
        : shared
          ? " A shared app: every member of every organization can open it."
          : plan.app.isDefault
            ? " Everyone in the organization can open it."
            : ` New apps are private: only ${deployerGranted ? "you and " : ""}the organization's owners and admins can open it. Grant others in Admin → Apps.`
    }${isNew && !hasOwner ? ` The gateway has no owner yet: its first owner gets the app (${CLI} setup).` : ""}`,
    data: {
      appId: manifest.id,
      workerName,
      hostname,
      status: plan.app.status,
      existingApp: !isNew,
      defaultAccess: plan.app.isDefault,
      deployerAccess: deployerGranted,
      scope: plan.app.scope,
      organizationId: organization.id,
      organizationName: organization.name,
      ...(secretNames.length > 0 ? { secrets: secretNames } : {}),
      ...(unsetNames.length > 0 ? { unsetSecrets: unsetNames } : {}),
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
      onChanged: (message: string) =>
        out.emit({ type: "progress", step: "app.resources", message }),
    };
    // The app's helper Workers (`workers`), named after its own.
    const helpers = (manifest.workers ?? []).map((helper) => ({
      name: helper.name,
      workerName: helperWorkerName(workerName, helper.name),
    }));
    await claimAppWorker(ownership);
    for (const helper of helpers) await claimAppWorker(ownership, helper);
    // Mail routes are checked before anything is created: an address
    // another app or rule has, or a domain whose routing stays off, stops
    // the deploy here.
    const emailRoutes = await planEmailRoutes({
      cf,
      gatewayDb: registry,
      accountId,
      workerName,
      manifest,
      interactive,
      enableRouting: options.enableEmailRouting,
      confirm: options.confirm,
    });
    const resources = await provisionAppResources({
      ...ownership,
      manifest,
      secrets: appSecrets,
    });

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
      ...(shared ? { shared: true as const } : {}),
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
    const { workflows, helperWorkflows } = await prepareAppBuildOutput({
      cwd,
      inputs: {
        ...inputs,
        helperWorkers: helpers.map((helper) => helper.workerName),
      },
    });
    await assertOwnWorkflows({ cf, workerName, names: workflows });
    for (const helper of helpers) {
      await assertOwnWorkflows({
        cf,
        workerName: helper.workerName,
        names: helperWorkflows[helper.workerName] ?? [],
      });
    }
    out.emit({
      type: "step",
      step: "app.build",
      status: "ok",
      message: helpers.length
        ? "Built the app and checked its Workers."
        : "Built the app and checked its Worker.",
      data: {
        workflows: [...workflows, ...Object.values(helperWorkflows).flat()],
      },
    });
    // Migrations that lag the schema would go live with code that needs more.
    await checkSchemaDrift({ cwd, manifest, out });

    // The database changes only once nothing else can stop the upload.
    const workerRecords = (await readOwnedResources(registry, workerName)).filter(
      (resource) => resource.kind === "worker",
    );
    const recordedVersion = (binding: string) =>
      workerRecords.find((record) => record.binding === binding)?.versionId;
    await assertReplaceable({
      cf,
      workerName,
      recordedVersionIds: [plan.versionId, recordedVersion("")],
      interactive,
      confirm: options.confirm,
    });
    for (const helper of helpers) {
      await assertReplaceable({
        cf,
        workerName: helper.workerName,
        recordedVersionIds: [recordedVersion(helper.name)],
        interactive,
        confirm: options.confirm,
      });
    }
    if (unsetNames.length > 0) {
      await lease.check();
      await dropSecrets({ cf, registry, workerName, names: unsetNames, out });
      for (const helper of helpers) {
        await dropSecrets({
          cf,
          registry,
          workerName,
          helper,
          names: unsetNames,
          out,
        });
      }
    }
    await lease.check();
    migrated.rollbackCommand = await migrate({
      cf,
      out,
      cwd,
      manifest,
      resources,
      accountId,
      appSecrets,
      drizzleKit: options.drizzleKit,
      prisma: options.prisma,
    });

    // Helper Workers first: the app's Worker binds them, so each must be
    // there (with any new class) before the version that uses it. The
    // app's own secrets go to each, as all of them are the app's code.
    for (const helper of helpers) {
      await lease.check();
      out.emit({
        type: "step",
        step: "app.upload",
        status: "start",
        message: `Uploading ${helper.workerName}...`,
      });
      await cfDeploy({
        cf,
        cwd,
        workerName: helper.workerName,
        buildOutputWorker: helper.workerName,
        accountId,
        message: `everyapp ${cliVersion} ${manifest.id} ${helper.name}`,
        secrets: options.secrets,
        interactive,
        onUploaded: (uploadedVersion) =>
          recordUploadedVersion(registry, workerName, uploadedVersion, helper.name),
      });
    }

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
        // A shared app serves every organization: nothing pins it to one.
        ...(shared ? {} : { EVERY_APP_ORG_ID: organization.id }),
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
    // The rules name the Worker, so they come once it is there.
    if (emailRoutes) {
      await lease.check();
      out.emit({
        type: "step",
        step: "app.email",
        status: "start",
        message: `Routing ${manifest.id}'s mail...`,
      });
      const routed = await applyEmailRoutes({
        cf,
        gatewayDb: registry,
        plan: emailRoutes,
        onProgress: (message) =>
          out.emit({ type: "progress", step: "app.email", message }),
      });
      const removed = emailRoutes.dropped.map((route) => route.name);
      out.emit({
        type: "step",
        step: "app.email",
        status: "ok",
        message: emailRouteSummary(manifest, workerName, routed, removed),
        data: { addresses: routed, removed },
      });
    }
    // A helper Worker the manifest dropped keeps running (with its crons)
    // until the app is purged: the deploy never deletes a Worker.
    const droppedHelpers = (plan.previousManifest?.workers ?? [])
      .map((helper) => String(helper.name))
      .filter((name) => !helpers.some((helper) => helper.name === name));
    for (const name of droppedHelpers) {
      out.emit({
        type: "warning",
        code: "HELPER_WORKER_KEPT",
        step: "app.upload",
        message: `everyapp.config.ts no longer declares the helper Worker ${name}; ${helperWorkerName(workerName, name)} keeps running until \`${CLI} delete ${manifest.id} --purge\` or until you delete it with npx cf.`,
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
    databaseId,
    out,
    accountId,
    workerName,
    publishHost: newHost,
    interactive,
    forceDns: options.forceDns,
    seams: {
      openRelease: () => openGatewayRelease({ out, verbose: options.verbose }),
      ...options.reconcile,
    },
  });
  // A hostname the gateway doesn't publish never answers (warned above).
  const wait = !outsideBase && (options.waitForLive ?? true);
  if (!outsideBase && !wait) {
    out.emit({
      type: "progress",
      step: "app.live",
      message: `${manifest.id} goes live on its first visit to https://${hostname}${newHost ? ", once its certificate comes (within a few minutes)" : ""}; \`${CLI} status\` shows it.`,
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

/**
 * Where the app's mail goes now, and what replying from those addresses
 * still needs: each domain onboarded to Email Sending and named in
 * `capabilities.email.senders`.
 */
function emailRouteSummary(
  manifest: EveryAppCliManifest,
  workerName: string,
  routed: string[],
  removed: string[],
): string {
  const gone = removed.length ? ` Removed the routes for ${removed.join(", ")}.` : "";
  if (routed.length === 0) return `${manifest.id} receives no mail.${gone}`;
  const senders = manifest.capabilities?.["email"]?.senders ?? [];
  const unsent = [...new Set(routed.map((address) => address.slice(address.indexOf("@") + 1)))].filter(
    (domain) => !senders.some((sender) => sender.endsWith(`@${domain}`)),
  );
  const replies = unsent.length
    ? ` To reply from ${unsent.join(", ")}, onboard ${unsent.length === 1 ? "it" : "them"} to Email Sending and list ${unsent.length === 1 ? "it" : "them"} in capabilities.email.senders (docs/runbooks/email-sending-setup.md).`
    : "";
  return `Mail to ${routed.join(", ")} goes to ${workerName}.${gone}${replies}`;
}

/**
 * Shared apps are the hosted gateway's: one self-hosted (or of no recorded
 * mode) has none, and nothing registers one there.
 */
export function assertSharedApps(install: Pick<InstallRecord, "deploymentMode">): void {
  if (install.deploymentMode === "hosted") return;
  throw new EveryAppError(
    "SHARED_APPS_UNAVAILABLE",
    `Shared apps are for the hosted gateway; this one is ${install.deploymentMode ?? "of no recorded mode"}. Deploy without --shared to make it your organization's own app.`,
  );
}

/** Durable Object classes the last deploy had and this one drops. */
function checkDurableObjects(
  plan: RegistrationPlan,
  manifest: EveryAppCliManifest,
  allowDelete: boolean,
): string[] {
  const current = new Map(
    (manifest.resources?.durableObjects ?? []).map((d) => [d.className, d.worker]),
  );
  for (const durableObject of plan.previousManifest?.resources?.durableObjects ?? []) {
    const className = String(durableObject.className);
    const before = durableObject.worker ? String(durableObject.worker) : undefined;
    // Cloudflare moves a class's data between Workers only by a transfer,
    // which the deploy never makes; and a helper Worker gets no tombstones.
    if (current.has(className) && current.get(className) !== before) {
      throw new EveryAppError(
        "DURABLE_OBJECT_MOVED",
        `everyapp.config.ts moves the Durable Object class ${className} to another Worker. Its data can't follow it; give the class a new name instead.`,
      );
    }
    if (!current.has(className) && before) {
      // Its own code: --allow-delete-durable-object-data doesn't cover it.
      throw new EveryAppError(
        "HELPER_DURABLE_OBJECT_REMOVED",
        `everyapp.config.ts no longer declares the Durable Object class ${className}, which helper Worker ${before} defines. Removing a helper Worker's class isn't supported yet; keep declaring it.`,
      );
    }
  }
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
 * on the Worker that defined them (the app's or a helper's): like a
 * Durable Object class, deleting one deletes its instances, so only with
 * --allow-delete-workflows.
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
  appSecrets,
  drizzleKit,
  prisma,
}: {
  cf: CfRunner;
  out: EventSink;
  cwd: string;
  manifest: EveryAppCliManifest;
  resources: DeployInputs["resources"];
  accountId: string;
  appSecrets: AppSecrets;
  drizzleKit?: DrizzleKitRunner;
  prisma?: PrismaRunner;
}): Promise<string | null> {
  if (manifest.migrations?.dialect === "postgresql") {
    await migratePostgresDatabase({ out, cwd, manifest, appSecrets, drizzleKit, prisma });
    return null;
  }
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
 * Postgres has no restore point to offer: its own backups are the way
 * back. drizzle-kit runs when the migrations directory is there; Prisma
 * finds its migrations through its config, so its run is skipped only for
 * a `dir` the manifest names that is missing.
 */
async function migratePostgresDatabase({
  out,
  cwd,
  manifest,
  appSecrets,
  drizzleKit,
  prisma,
}: {
  out: EventSink;
  cwd: string;
  manifest: EveryAppCliManifest;
  appSecrets: AppSecrets;
  drizzleKit?: DrizzleKitRunner;
  prisma?: PrismaRunner;
}): Promise<void> {
  const engine = manifest.migrations?.engine === "prisma" ? "prisma" : "drizzle";
  const dir =
    manifest.migrations?.dir ?? (engine === "drizzle" ? "drizzle" : undefined);
  if (dir !== undefined && !(await isDirectory(path.resolve(cwd, dir)))) {
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
    message: "Migrating the app's Postgres database...",
  });
  const migration = {
    cwd,
    // Checked before anything was created (deploySteps).
    databaseUrl: appSecrets[POSTGRES_URL_VARIABLE]!,
    config: manifest.migrations?.config,
  };
  if (engine === "prisma") {
    await migratePrismaPostgres({ ...migration, ...(prisma ? { run: prisma } : {}) });
  } else {
    await migratePostgres({ ...migration, ...(drizzleKit ? { run: drizzleKit } : {}) });
  }
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "ok",
    message: `Migrated the app's Postgres database (${engine === "prisma" ? "prisma migrate deploy" : "drizzle-kit migrate"}).`,
    data: { dialect: "postgresql", engine },
  });
}

/**
 * Reconcile the gateway when the install row says it doesn't bind this
 * app's Worker yet, or doesn't publish its hostname yet.
 */
export async function bindIfNeeded({
  cf,
  db,
  databaseId,
  out,
  accountId,
  workerName,
  publishHost,
  interactive,
  forceDns,
  seams,
  rerun = `${CLI} deploy`,
}: {
  cf: CfRunner;
  db: D1Database;
  databaseId: string;
  out: EventSink;
  accountId: string;
  workerName: string;
  /** The app's hostname isn't one of the gateway's Custom Domains yet. */
  publishHost: boolean;
  interactive: boolean;
  forceDns?: boolean;
  seams: ReconcileSeams & Required<Pick<ReconcileSeams, "openRelease">>;
  /** What to run again when the gateway is busy. */
  rerun?: string;
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
    // The gateway this checkout builds: an upgrade too, when it is newer.
    const result = await reconcileGateway({
      cf,
      out,
      accountId,
      databaseId,
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
        `${error.message} This app's upload is kept: run \`${rerun}\` again once the gateway is free, and it binds the app and makes it live.`,
        { retryable: true, rerun },
      );
    }
    throw error;
  }
}

/**
 * Delete secrets from the app's Worker. Cloudflare makes a new version of
 * the live one without them, recorded as the app's own so the upload that
 * follows replaces it unattended as well.
 */
async function dropSecrets({
  cf,
  registry,
  workerName,
  helper,
  names,
  out,
}: {
  cf: CfRunner;
  registry: D1Database;
  /** The app's Worker, which the records are kept under. */
  workerName: string;
  /** One of its helper Workers instead (`workers`), whose copies go too. */
  helper?: { name: string; workerName: string };
  names: readonly string[];
  out: EventSink;
}): Promise<void> {
  const target = helper?.workerName ?? workerName;
  for (const name of names) {
    const deleted = await deleteWorkerSecret(cf, target, name);
    out.emit({
      type: "progress",
      step: "app.secrets",
      message: deleted
        ? `Deleted the secret ${name} from ${target}.`
        : `${target} has no secret ${name}.`,
    });
  }
  const serving = await getWorkerDeployment(cf, target);
  if (serving?.versionId) {
    await recordUploadedVersion(
      registry,
      workerName,
      serving.versionId,
      helper?.name,
    );
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
