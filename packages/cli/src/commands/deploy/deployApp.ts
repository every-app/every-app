/**
 * Deploying an app (`everyapp deploy`):
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
 *      buckets (left to `cf deploy` to create), `cf build` the app
 *      (tenant-neutral: placeholders for everything install-specific),
 *      install the Build Output for this deploy (lib/app/
 *      installBuildOutput.ts: the Worker name, organization, gateway, the
 *      gateway's identity key from the install row, the resources' names
 *      and ids, deleted Durable Object classes) and
 *      check the installed Workers against the app policy and their
 *      Workflows' names (each new or already the app's), check that its drizzle
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
 *      the upload is live, and its Email Routing routes (the installation's
 *      inbound addresses, `everyapp email set --inbound`,
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
 * From an app release (`release`: `everyapp install <github url | tarball>`,
 * lib/app/release.ts) the pipeline is the same with the extracted release
 * as the Build Output root and its manifest as the app's: nothing is
 * installed or built, and the schema check is left to the publisher's
 * build, which ran it when it packed the release. Its D1 migrations come
 * from the release's migrations/; Postgres migrations need the app's
 * source (drizzle-kit, Prisma), so a release with them is refused.
 *
 * A new hostname is checked (DNS records that answer it, the zone's room)
 * right after registering, before anything is created or uploaded.
 * A redeploy of an app the gateway already binds and serves never touches
 * the gateway. The gateway takes the app's agent tools itself, on first use
 * and whenever the app's version changes.
 */
import path from "node:path";
import { version as cliVersion } from "../../../package.json";
import { manifestTierProblems, validateManifestStrict } from "@every-app/perimeter/manifest";
import type { RegistrationPlan } from "@every-app/perimeter/registry";
import { helperWorkerName } from "@every-app/sdk/cloudflare";
import { capabilityIdsOf, type AppSetup, type ProviderRegistry } from "@every-app/sdk/internal";
import {
  awaitLive,
  bindIfNeeded,
  gatewayFor,
  registerFromManifest,
  type ReconcileSeams,
} from "@/commands/appGateway";
import { setupDeps, type SetupDeps } from "@/commands/setup/runSetup";
import { checkSchemaDrift } from "./steps/checkSchemaDrift";
import { offerGateway } from "./steps/offerGateway";
import { LiveWaitVerb, type LiveWaitSeams } from "./steps/waitForLive";
import { syncAppsAccessAfter } from "@/lib/access/sync";
import { buildApp } from "@/lib/app/buildApp";
import {
  MISSING_CLOUDFLARE_CONFIG,
  readCloudflareConfig,
} from "@/lib/app/cloudflareConfig";
import {
  installAppBuildOutput,
  type InstallTarget,
} from "@/lib/app/installBuildOutput";
import {
  APP_SECRETS_FILE,
  POSTGRES_URL_VARIABLE,
  readAppSecrets,
  type AppSecrets,
} from "@/lib/app/deploySecrets";
import { ensureR2Buckets } from "@/lib/app/buckets";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { mcpOf, publicRoutesOf, type McpSummary, type PublicRouteSummary } from "@/lib/app/publicRoutes";
import { describeAppOrigin, type AppRelease } from "@/lib/app/release";
import {
  readOwnedResources,
  recordUploadedVersion,
  RESOURCE_LABELS,
} from "@/lib/app/ownership";
import { claimAppWorker, provisionAppResources } from "@/lib/app/resources";
import {
  appSetupFrom,
  declaresSettings,
  describeUnmet,
  listAppSecretNames,
  listGatewaySecretNames,
  namesToSet,
} from "@/lib/app/settings";
import {
  applyEmailRoutes,
  describeMailRoutes,
  emailDeclarations,
  planEmailRoutes,
  unsentDomains,
} from "@/lib/app/emailRoutes";
import {
  appWorkflows,
  assertOwnWorkflows,
  droppedWorkflows,
  type AppWorkflow,
} from "@/lib/app/workflows";
import type { D1Database } from "@/lib/cf/d1";
import { assertReplaceable, cfDeploy } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorkflowIfExists } from "@/lib/cf/workflows";
import { preflightAppHost } from "@/lib/domains/preflight";
import { afterMigration, errorMessage, EveryAppError, type Rollback } from "@/lib/errors";
import { directoryExists } from "@/lib/file-operations";
import { connectToGateway } from "@/lib/gateway/connect";
import { refuseOlderCheckout } from "@/lib/gateway/apply";
import { acquireAppLease, LeasePurpose } from "@/lib/gateway/lease";
import { gatewayRegistry } from "@/lib/gateway/providers";
import { recordSetupStateQuietly } from "@/lib/gateway/setupState";
import {
  findRegisteredApp,
  installOrganization,
  markDeployed,
  readAppEmail,
} from "@/lib/gateway/registry";
import {
  loadEveryAppManifest,
  migrationsDir,
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import type { MigrationCliRunner } from "@/lib/migrations/localCli";
import { migratePostgres } from "@/lib/migrations/postgres";
import { migratePrismaPostgres } from "@/lib/migrations/prisma";
import {
  migrateRemoteD1,
  migrationEventData,
  restorePointNote,
} from "@/lib/migrations/remote";
import { appRestoreTarget } from "@/lib/gateway/restorePoints";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, type Confirm } from "@/lib/output/prompt";
import { listed } from "@/lib/output/text";
import { installDependencies } from "@/lib/package-manager";

interface DeployAppOptions {
  /** The app's directory; with `release`, where its secrets file is read. */
  cwd: string;
  manifest?: EveryAppCliManifest;
  /**
   * Deploy this app release (its manifest the app's) instead of building
   * the app in `cwd`.
   */
  release?: AppRelease;
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
   * Turn Email Routing on for the domains the app's inbound addresses name
   * that don't route mail yet, without asking (`--enable-email-routing`).
   */
  enableEmailRouting?: boolean;
  /**
   * Wait for the app to go live, its new hostname's certificate included
   * (default true; `--no-wait`). Without the wait, it goes live on its
   * first visit.
   */
  waitForLive?: boolean;
  /**
   * With no Gateway in any account the login sees, offer to install one
   * (`deploy`): at a terminal setup's pipeline runs
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
  drizzleKit?: MigrationCliRunner;
  /** Runs the Prisma CLI for migrations.engine "prisma" (default: the app's own). */
  prisma?: MigrationCliRunner;
  reconcile?: ReconcileSeams;
  live?: LiveWaitSeams;
}

interface DeployAppResult {
  liveUrl: string;
  gatewayUrl: string;
  organizationId: string;
  organizationName: string;
  hostname: string;
  workerName: string;
  versionId: string;
  /** The registry says the app is active (it can also go live on its first visit). */
  live: boolean;
  /** The routes the manifest opens to anyone on the internet (`done`'s `data.publicRoutes`). */
  publicRoutes: PublicRouteSummary[];
  /** The manifest's `mcp`: its host answers `/mcp`, and why (`done`'s `data.mcp`); null when it sets none. */
  mcp: McpSummary | null;
  /** What to run next, when something is left to do (`done`'s `data.next`). */
  next: Array<{ command: string; note: string }>;
}

/** An app in these states has never been live: its deploy is still its first. */
const NEVER_LIVE = new Set(["pending", "binding"]);

export async function deployApp(
  options: DeployAppOptions,
): Promise<DeployAppResult> {
  const migrated: Migrated = { rollback: null };
  try {
    return await deploySteps(options, migrated);
  } catch (error) {
    // Once the app's database changed, a failure says how to put it back.
    throw afterMigration(error, migrated.rollback);
  }
}

/** The restore point of the app's database, once this deploy migrated it. */
interface Migrated {
  rollback: Rollback | null;
}

async function deploySteps(
  options: DeployAppOptions,
  migrated: Migrated,
): Promise<DeployAppResult> {
  const { cwd, out } = options;
  const interactive =
    options.interactive ?? canPromptInTerminal(options.json ?? false);

  const release = options.release;
  const manifest =
    release?.manifest ?? options.manifest ?? (await loadEveryAppManifest(cwd));
  // Where the Build Output and the migrations are.
  const root = release?.dir ?? cwd;
  if (release) refuseReleaseMigrations(manifest);
  // What reaches the app's Postgres database, checked before anything is created.
  const postgresMigrations = manifest.migrations?.dialect === "postgresql";
  const appSecrets: AppSecrets =
    postgresMigrations ||
    manifest.resources?.hyperdrive?.length ||
    manifest.resources?.secretsStore?.length
      ? await readAppSecrets(cwd)
      : {};
  if (postgresMigrations && !appSecrets[POSTGRES_URL_VARIABLE]) {
    throw new EveryAppError(
      "POSTGRES_URL_MISSING",
      `${manifest.id} needs a Postgres URL to migrate its database\nFormat: postgres://<user>:<password>@<host>:<port>/<database>`,
      { fix: `set ${POSTGRES_URL_VARIABLE} in ${APP_SECRETS_FILE}, then deploy again` },
    );
  }
  // A release's Build Output is checked against the policy all the same.
  const cloudflareConfig = release ? null : await readCloudflareConfig(cwd);
  if (!release && !cloudflareConfig) {
    throw new EveryAppError("MISSING_CLOUDFLARE_CONFIG", MISSING_CLOUDFLARE_CONFIG);
  }
  if (cloudflareConfig && !cloudflareConfig.usesEveryAppWorker) {
    out.emit({
      type: "warning",
      code: "NONSTANDARD_CLOUDFLARE_CONFIG",
      message:
        "cloudflare.config.ts doesn't use everyAppWorker()\nThe deploy checks the Worker it builds against the app policy.",
    });
  }

  // 1. The gateway, through the Cloudflare login: its account, D1 and
  // install. With none anywhere, `deploy` offers to install one first.
  const offer = options.offerInstall;
  const gateway = gatewayFor(options.reconcile, out, options.verbose);
  out.emit({ type: "step", step: "app.connect", status: "start", message: "Finding your Gateway..." });
  const { cf, accountId, accountName, databaseId, db: registry, install, gatewayUrl, deployer } =
    await connectToGateway({
      gateway: options.gateway,
      accountId: options.accountId,
      interactive,
      // An agent reading --json gets cf's device login, and the run waits.
      login: { json: options.json, out, step: "app.login" },
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
                  ...setupDeps({ gateway, interactive }),
                  ...(options.createCf ? { createCf: options.createCf } : {}),
                  ...offer.setup,
                },
              },
            })
        : undefined,
    });
  out.emit({ type: "step", step: "app.connect", status: "ok", data: { gatewayUrl } });
  // The manifest against what this Gateway offers: the catalog and the
  // providers registered on it, before anything is registered or built.
  const providers = await gatewayRegistry(registry, install);
  checkCapabilitiesOffered(manifest, providers, gatewayUrl);
  // A person's first line, before anything can stop the run: where this
  // goes, and whether the app has ever been live (a first deploy that
  // stopped part way is still the first).
  const [installOrg, registered] = await Promise.all([
    installOrganization(registry),
    findRegisteredApp(registry, manifest.id),
  ]);
  const firstDeploy = !registered || NEVER_LIVE.has(registered.status);
  out.emit({
    type: "step",
    step: "app.deploy",
    status: "ok",
    message: `Deploying ${manifest.id}${release ? ` ${release.release.version} from ${describeAppOrigin(release.origin)}` : ""} to ${gatewayUrl}.`,
    data: {
      appId: manifest.id,
      organizationName: installOrg?.organization.name ?? accountName,
      firstDeploy,
      gatewayUrl,
      gatewayHost: new URL(gatewayUrl).host,
      ...(release
        ? {
            version: release.release.version,
            origin: describeAppOrigin(release.origin),
            release: {
              version: release.release.version,
              gitSha: release.release.gitSha,
              origin: release.origin,
              sha256: release.release.sha256,
            },
          }
        : {}),
    },
  });
  // Before anything is registered: never with a Gateway behind the live one.
  await refuseOlderCheckout(install, gateway.source);
  const identityKey = install.jwtPublicKey;
  if (!identityKey) {
    throw new EveryAppError(
      "IDENTITY_KEY_UNKNOWN",
      "The Gateway is missing its sign-in public key\nApp Workers need it to check who is signed in.",
      {
        fix: "restore JWT_PUBLIC_KEY as in https://github.com/every-app/every-app/blob/main/docs/runbooks/key-rotation.md",
      },
    );
  }

  // 2. Register: the rules name everything.
  const { plan, organization, hasOwner, deployerGranted } = await registerFromManifest(
    registry,
    { manifest, install, deployer, accountName },
  );
  const hostname = plan.app.hostname!;
  const workerName = plan.app.workerName!;
  const isNew = plan.kind !== "existing";
  const tierProblems = manifestTierProblems(manifest, plan.app.tier);
  if (tierProblems.length > 0) {
    throw new EveryAppError(
      "TIER_POLICY",
      `${manifest.id} can't be deployed as configured\n${tierProblems.join("\n")}`,
      { fix: "change everyapp.config.ts, then deploy again" },
    );
  }
  // Until the app has been live once, the end of the run says who can open
  // it; what the manifest opens to the internet, and whether its host
  // answers /mcp, it says every time.
  const publicRoutes = publicRoutesOf(manifest);
  const mcp = mcpOf(manifest);
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${isNew ? "Registered" : "Updating"} ${manifest.id} as ${workerName} at https://${hostname} (${plan.app.status}).`,
    data: {
      appId: manifest.id,
      workerName,
      hostname,
      status: plan.app.status,
      existingApp: !isNew,
      firstDeploy,
      defaultAccess: plan.app.isDefault,
      deployerAccess: deployerGranted,
      hasOwner,
      publicRoutes,
      mcp,
      scope: plan.app.scope,
      organizationId: organization.id,
      organizationName: organization.name,
      gatewayUrl,
    },
  });

  // A hostname the gateway doesn't serve yet is checked before anything is
  // created or uploaded; the reconcile that publishes it checks again. One
  // that isn't one label below the base is never published, so it is
  // neither checked nor a reason to redeploy the gateway (said at the end).
  const { outsideBase, newHost } = await preflightAppHost({
    cf,
    out,
    install,
    hostname,
    forceDns: options.forceDns,
    cfAsks: interactive && out.verbose,
  });

  // 3. Everything that touches the app's Worker and data, one deploy at a time.
  const lease = await acquireAppLease(
    { db: registry, out },
    { workerName, appId: manifest.id, purpose: LeasePurpose.AppDeploy },
  );
  let versionId: string;
  let status: string;
  const next: DeployAppResult["next"] = [];
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
    let createdHyperdrive = false;
    const ownership = {
      cf,
      gatewayDb: registry,
      registration: { workerName, resources: plan.resources },
      onCreated: (description: string, kind: keyof typeof RESOURCE_LABELS) => {
        out.emit({ type: "progress", step: "app.resources", message: `Created ${description}.` });
        if (kind === "hyperdrive") createdHyperdrive = true;
      },
      onRecreated: (description: string, kind: keyof typeof RESOURCE_LABELS) =>
        out.emit({
          type: "warning",
          code: "RESOURCE_RECREATED",
          step: "app.resources",
          message: `The ${kind === "d1" ? "database" : RESOURCE_LABELS[kind]} ${manifest.id} used before is gone; creating a new, empty one\n${description} no longer exists in this Cloudflare account.`,
        }),
      onChanged: (message: string) =>
        out.emit({ type: "progress", step: "app.resources", message }),
    };
    // The app's helper Workers (`workers`), named after its own.
    const helpers = (manifest.workers ?? []).map((helper) => ({
      name: helper.name,
      workerName: helperWorkerName(workerName, helper.name),
    }));
    out.emit({
      type: "step",
      step: "app.resources",
      status: "start",
      message: "Preparing the app's resources...",
    });
    await claimAppWorker(ownership);
    for (const helper of helpers) await claimAppWorker(ownership, helper);
    // The installation's email lists live on its registry row, read under
    // the lease so `everyapp email set` can't change them between this check
    // and the routes made after the upload. Without the manifest's
    // declaration no Worker of the app receives mail: its routes go, its
    // addresses stay stored.
    const storedEmail = await readAppEmail(registry, plan.app.id);
    const declaresInbound = emailDeclarations(manifest).receives;
    if (!declaresInbound && storedEmail.inbound.length > 0) {
      out.emit({
        type: "warning",
        code: "EMAIL_INBOUND_UNDECLARED",
        step: "app.email",
        message: `everyapp.config.ts no longer declares inbound email; removing the app's mail routes\nIts addresses (${storedEmail.inbound.join(", ")}) stay on the Gateway until you clear them.`,
        data: { rerun: `${CLI} email unset inbound` },
      });
    }
    // Mail routes are checked before anything is created: an address
    // another app or rule has, or a domain whose routing stays off, stops
    // the deploy here.
    const emailRoutes = await planEmailRoutes({
      cf,
      gatewayDb: registry,
      accountId,
      workerName,
      addresses: declaresInbound ? storedEmail.inbound : [],
      interactive,
      enableRouting: options.enableEmailRouting,
      confirm: options.confirm,
    });
    const resources = await provisionAppResources({
      ...ownership,
      manifest,
      secrets: appSecrets,
      accountId,
    });
    out.emit({ type: "step", step: "app.resources", status: "ok", message: "The app's resources are ready." });
    if (createdHyperdrive) {
      const caching = manifest.resources?.hyperdrive?.some((config) => config.caching === "default")
        ? "default"
        : "off";
      out.emit({
        type: "step",
        step: "app.hyperdrive",
        status: "ok",
        message: "Created the app's Hyperdrive config.",
        data: { caching },
      });
    }

    if (!release && manifest.install !== false) {
      out.emit({ type: "step", step: "app.install", status: "start", message: "Installing dependencies..." });
      await (options.installDeps ?? installDependencies)({
        cwd,
        description: "Installing dependencies...",
        install: manifest.install,
        verbose: options.verbose ?? false,
      });
      out.emit({ type: "step", step: "app.install", status: "ok" });
    }

    const target: InstallTarget = {
      workerName,
      organizationId: organization.id,
      accountId,
      gatewayUrl,
      identityPublicKeys: [identityKey],
      resources,
      deletedDurableObjects,
      helperWorkers: helpers.map((helper) => helper.workerName),
      declared: manifest.resources,
    };
    if (!release) {
      out.emit({ type: "step", step: "app.build", status: "start", message: "Building..." });
      await buildApp({
        cwd,
        cf,
        buildCommand: manifest.build,
        verbose: options.verbose ?? false,
      });
    }
    await installAppBuildOutput({ cwd: root, target });
    const { workflows, helperWorkflows, r2Buckets } = await prepareAppBuildOutput({
      cwd: root,
      inputs: target,
    });
    await ensureR2Buckets({ cf, names: r2Buckets, appId: manifest.id, out });
    for (const worker of [
      { workerName, names: workflows },
      ...helpers.map((helper) => ({
        workerName: helper.workerName,
        names: helperWorkflows[helper.workerName] ?? [],
      })),
    ]) {
      await assertOwnWorkflows({ cf, ...worker });
    }
    out.emit({
      type: "step",
      step: "app.build",
      status: "ok",
      message: `${release ? "Installed the release" : "Built the app"} and checked its Worker${helpers.length ? "s" : ""}.`,
      data: {
        release: release !== undefined,
        workflows: [...workflows, ...Object.values(helperWorkflows).flat()],
      },
    });
    // Migrations that lag the schema would go live with code that needs more.
    if (release) {
      out.emit({
        type: "progress",
        step: "app.schema",
        message: `The release's publisher checked its migrations against its schema when it packed ${manifest.id} ${release.release.version}.`,
      });
    } else {
      await checkSchemaDrift({ cwd, manifest, out });
    }

    // The database changes only once nothing else can stop the upload.
    const workerRecords = (await readOwnedResources(registry, workerName)).filter(
      (resource) => resource.kind === "worker",
    );
    const recordedVersion = (binding: string) =>
      workerRecords.find((record) => record.binding === binding)?.versionId;
    const replace = {
      question: "Replace the version that's serving?",
      effect: "Migrations run first.",
    };
    for (const worker of [
      {
        workerName,
        shownAs: manifest.id,
        recordedVersionIds: [plan.versionId, recordedVersion("")],
      },
      ...helpers.map((helper) => ({
        workerName: helper.workerName,
        shownAs: `${manifest.id}'s ${helper.name} Worker`,
        recordedVersionIds: [recordedVersion(helper.name)],
      })),
    ]) {
      await assertReplaceable({
        cf,
        ...worker,
        interactive,
        confirm: options.confirm,
        change: replace,
      });
    }
    await lease.check();
    migrated.rollback = await migrate({
      cf,
      out,
      cwd: root,
      manifest,
      resources,
      accountId,
      registry,
      workerName,
      // A release isn't deployed from the app's directory.
      restoreCommand: `${CLI} db restore${release ? ` ${manifest.id}` : ""}`,
      appSecrets,
      drizzleKit: options.drizzleKit,
      prisma: options.prisma,
    });

    // What every Worker of the app gets with its version: what names the
    // gateway and the organization to the SDK. A helper calls the gateway
    // too (a crawl's rendering, say), and without EVERY_APP_ORG_ID it would
    // name the app's own organization id, which the gateway refuses.
    const versionSecrets = {
      GATEWAY_URL: gatewayUrl,
      EVERY_APP_ORG_ID: organization.id,
    };

    // Helper Workers first: the app's Worker binds them, so each must be
    // there (with any new class) before the version that uses it.
    for (const helper of helpers) {
      await lease.check();
      out.emit({
        type: "step",
        step: "app.helper",
        status: "start",
        message: `Uploading ${helper.workerName}...`,
        data: { name: helper.name, workerName: helper.workerName },
      });
      await cfDeploy({
        cf,
        cwd: root,
        workerName: helper.workerName,
        buildOutputWorker: helper.workerName,
        accountId,
        message: `everyapp ${cliVersion} ${manifest.id} ${helper.name}`,
        secrets: versionSecrets,
        interactive,
        attach: out.verbose,
        out,
        step: "app.helper",
        onUploaded: (uploadedVersion) =>
          recordUploadedVersion(registry, workerName, uploadedVersion, helper.name),
      });
      out.emit({
        type: "step",
        step: "app.helper",
        status: "ok",
        message: `Uploaded ${helper.workerName}.`,
        data: { name: helper.name, workerName: helper.workerName },
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
      cwd: root,
      workerName,
      accountId,
      message: `everyapp ${cliVersion} ${manifest.id}`,
      secrets: versionSecrets,
      interactive,
      attach: out.verbose,
      out,
      step: "app.upload",
      // Recorded at once, before the registry hears of it: a retry must
      // find this upload was everyapp's, however this run ends.
      onUploaded: (uploadedVersion) =>
        recordUploadedVersion(registry, workerName, uploadedVersion),
    });
    if (!uploaded.versionId) {
      throw new EveryAppError(
        "VERSION_UNKNOWN",
        `Cloudflare reports no version for ${manifest.id} after the upload`,
        { data: { workerName } },
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
      await deleteWorkflowIfExists(cf, workflow.name);
      out.emit({
        type: "step",
        step: "app.workflows",
        status: "ok",
        message: `Deleted the Workflow ${workflow.binding} (${workflow.name}) with its instances.`,
        data: { binding: workflow.binding, name: workflow.name },
      });
    }
    // The installation's senders are its own to set, on a Gateway that takes them.
    const sendersSettable =
      emailDeclarations(manifest).sends && install.deploymentMode !== "hosted";
    // The rules name the Worker, so they come once it is there.
    if (emailRoutes) {
      await lease.check();
      out.emit({
        type: "step",
        step: "app.email",
        status: "start",
        message: `Routing ${manifest.id}'s mail...`,
        data: { removing: emailRoutes.routes.length === 0 },
      });
      const { routed, removed } = await applyEmailRoutes({
        cf,
        gatewayDb: registry,
        plan: emailRoutes,
        onProgress: (message) =>
          out.emit({ type: "progress", step: "app.email", message }),
      });
      const mail = {
        appId: manifest.id,
        workerName,
        senders: storedEmail.senders,
        routed,
        removed,
        sendersSettable,
      };
      const unsent = mail.sendersSettable ? unsentDomains(mail.routed, mail.senders) : [];
      out.emit({
        type: "step",
        step: "app.email",
        status: "ok",
        message: describeMailRoutes(mail),
        data: {
          addresses: routed,
          removed,
          enabled: emailRoutes.enable.map(({ domain }) => domain),
          ...(unsent.length > 0
            ? {
                replyHint: `To reply from ${unsent.join(", ")}, set up Email Sending, then: ${CLI} email set --sender`,
              }
            : {}),
        },
      });
    }
    if (!emailRoutes && declaresInbound && storedEmail.inbound.length === 0) {
      out.emit({
        type: "step",
        step: "app.email",
        status: "skip",
        message: `${manifest.id} receives no mail yet.`,
      });
      next.push({
        command: `${CLI} email set --inbound <address>`,
        note: `routes mail to ${manifest.id}`,
      });
    }
    // Until a sender is set, the app sends as the Gateway's sender.
    if (sendersSettable && storedEmail.senders.length === 0) {
      next.push({
        command: `${CLI} email set --sender '*@<domain>'`,
        note: `lets ${manifest.id} send as your domain`,
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
        message: `Helper Worker ${name} is no longer in everyapp.config.ts, but it still runs\nIts Worker is ${helperWorkerName(workerName, name)}.`,
        data: { fix: "delete that Worker in the Cloudflare dashboard" },
      });
    }
    // The Worker's own secret names, recorded with the version so the
    // gateway knows what is set. The upload stands when cf can't list them:
    // the next `status` records them.
    const secretNames = await listAppSecretNames(cf, workerName).catch((error: unknown) => {
      out.emit({
        type: "progress",
        step: "app.secrets",
        message: `Couldn't list ${workerName}'s secrets: ${errorMessage(error).split("\n")[0]}`,
      });
      return null;
    });
    status = await markDeployed(registry, plan.app.id, {
      versionId,
      manifest,
      actor: deployer.actor,
      email: deployer.email,
      source: release ? "release" : "cli",
      ...(secretNames ? { secretNames } : {}),
    });
    // What the app still needs set, once its upload is on record: a
    // warning with the one command, said again under Next; and the state
    // on the app's row, with app.needs_setup or app.ready on a change.
    const setup = await warnIfNeedsSetup({ cf, manifest, appId: manifest.id, secretNames, out, next, providers });
    await recordSetupStateQuietly(registry, { appRowId: plan.app.id, setup, deployer }, out);
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
    appId: manifest.id,
    workerName,
    publishHost: newHost,
    interactive,
    forceDns: options.forceDns,
    seams: { ...options.reconcile, openRelease: gateway.openRelease, source: gateway.source },
    verb: LiveWaitVerb.Deploy,
  });
  const url = `https://${hostname}`;
  // A hostname the gateway doesn't publish never answers.
  const wait = !outsideBase && (options.waitForLive ?? true);
  const live = await awaitLive({
    wait,
    db: registry,
    appRowId: plan.app.id,
    appId: manifest.id,
    hostname,
    out,
    seams: options.live,
    message: `${manifest.id} is live at ${url}.`,
    verb: LiveWaitVerb.Deploy,
  });
  if (!live) {
    // An app live before this redeploy stays live; the rest go live on
    // their first visit (or, outside the base domain, never).
    const reason = outsideBase
      ? "outside-base"
      : wait
        ? undefined
        : newHost
          ? "certificate"
          : "first-visit";
    out.emit(
      status === "active" && !outsideBase
        ? { type: "step", step: "app.live", status: "ok", message: `${manifest.id} is live at ${url}.`, data: { hostname, url } }
        : {
            type: "step",
            step: "app.live",
            status: "skip",
            message: `${manifest.id} isn't live yet: ${url}.`,
            data: { hostname, url, ...(reason ? { reason } : {}) },
          },
    );
  }
  // Behind Cloudflare Access, the app's public routes (and its /mcp, where
  // the manifest sets mcp) are let through as soon as it is live (nothing
  // to do when Access isn't in front).
  await syncAppsAccessAfter(
    { cf, db: registry, install, out },
    { appId: manifest.id, surface: { publicRoutes: publicRoutes.length > 0, mcp: mcp !== null } },
  );
  if (outsideBase) {
    out.emit({
      type: "warning",
      code: "APP_HOST_OUTSIDE_BASE",
      step: "app.domain",
      message: `${hostname} isn't one label below ${install.appBaseDomain}\nThe Gateway only serves names directly under ${install.appBaseDomain}, so ${manifest.id} can't be reached.`,
    });
  }

  return {
    liveUrl: url,
    gatewayUrl,
    organizationId: organization.id,
    organizationName: organization.name,
    hostname,
    workerName,
    versionId,
    live: live || (status === "active" && !outsideBase),
    publicRoutes,
    mcp,
    next,
  };
}

/**
 * After the upload is recorded: the manifest's settings against the
 * Gateway's names and the Worker's own. An app that needs setup gets an
 * APP_NEEDS_SETUP warning ("crm won't open until CONTEXT_API_KEY is set",
 * the first unmet setting's why under it) and one `next` entry with the
 * command that opens it (`everyapp configure <app>`). Nothing when the app declares nothing to set
 * (the Gateway's secrets aren't listed then). A list that fails leaves
 * its names unknown, which never blocks: with the Gateway's unlisted, a
 * secret of the app's own that is known to be unset still warns. Returns
 * the setup, for the state on the app's row.
 */
async function warnIfNeedsSetup({
  cf,
  manifest,
  appId,
  secretNames,
  out,
  next,
  providers,
}: {
  cf: CfRunner;
  manifest: EveryAppCliManifest;
  appId: string;
  secretNames: string[] | null;
  out: EventSink;
  next: DeployAppResult["next"];
  /** The catalog and the Gateway's registered providers. */
  providers: ProviderRegistry;
}): Promise<AppSetup> {
  // Nothing to set: ready, with nothing to list.
  if (!declaresSettings(manifest, providers)) {
    return appSetupFrom({ manifest, appId, gatewayNames: [], secretNames: [], lookup: providers }).setup;
  }
  const gatewayNames = await listGatewaySecretNames(cf).catch(() => null);
  const { setup } = appSetupFrom({ manifest, appId, gatewayNames, secretNames, lookup: providers });
  if (setup.ready || !setup.command) return setup;
  const names = namesToSet(setup);
  const why = setup.unmet.find((setting) => setting.why);
  out.emit({
    type: "warning",
    code: "APP_NEEDS_SETUP",
    step: "app.secrets",
    message: [
      `${appId} won't open until ${listed(names)} ${names.length === 1 ? "is" : "are"} set`,
      ...(why ? [describeUnmet(why)[0]!] : []),
    ].join("\n"),
    data: { setup },
  });
  next.push({ command: setup.command.command, note: `asks for each; ${appId} opens once they are set` });
  return setup;
}

/**
 * The manifest against the Gateway's registry, once connected (the load
 * before it accepted any well-formed capability id): an id neither the
 * catalog nor the Gateway's registered providers have is
 * CAPABILITY_UNKNOWN, naming the command that registers one; then the
 * strict validator with the registry, which checks a registered
 * provider's entry as a catalog one's (the access it offers) and refuses
 * an app secret a registered provider holds, in the words it refuses a
 * catalog key in (INVALID_MANIFEST).
 */
function checkCapabilitiesOffered(
  manifest: EveryAppCliManifest,
  providers: ProviderRegistry,
  gatewayUrl: string,
): void {
  const unknown = Object.keys(manifest.capabilities ?? {}).filter((id) => !providers.get(id));
  if (unknown.length > 0) {
    const offered = capabilityIdsOf(providers);
    throw new EveryAppError(
      "CAPABILITY_UNKNOWN",
      [
        `${manifest.id} lists ${listed(unknown)} under capabilities, which ${gatewayUrl.replace(/^https:\/\//, "")} doesn't offer`,
        `Neither the built-in catalog nor the providers registered on this Gateway ${unknown.length === 1 ? "has it" : "have them"}. It offers: ${offered.join(", ")}.`,
      ].join("\n"),
      {
        fix: `register ${unknown.length === 1 ? "it" : "each"} with ${CLI} provider add <spec.json or https URL> (or fix the id in everyapp.config.ts), then deploy again`,
        data: { unknown, offered },
      },
    );
  }
  validateManifestStrict(manifest, { capabilities: providers });
}

/**
 * A release carries SQL migration files, which only the D1 migration
 * applies by itself: Postgres migrations run the app's own drizzle-kit or
 * Prisma CLI with its config, which a release doesn't have.
 */
function refuseReleaseMigrations(manifest: EveryAppCliManifest): void {
  if (manifest.migrations?.dialect !== "postgresql") return;
  throw new EveryAppError(
    "RELEASE_MIGRATIONS_UNSUPPORTED",
    `${manifest.id} can't deploy from a release: its Postgres migrations need the source`,
    { fix: `clone it, then run pnpm install in it and this checkout's ${CLI} deploy from its directory` },
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
        `${className} can't move to another Worker\nA Durable Object's data can't follow it.`,
        { fix: "give the class a new name in everyapp.config.ts" },
      );
    }
    if (!current.has(className) && before) {
      // Its own code: --allow-delete-durable-object-data doesn't cover it.
      throw new EveryAppError(
        "HELPER_DURABLE_OBJECT_REMOVED",
        `The helper Worker ${before} still defines ${className}\nRemoving a helper Worker's Durable Object class isn't supported yet.`,
        { fix: `keep declaring ${className} in everyapp.config.ts` },
      );
    }
  }
  const removed = (plan.previousManifest?.resources?.durableObjects ?? [])
    .map((d) => String(d.className))
    .filter((className) => !current.has(className));
  if (removed.length > 0 && !allowDelete) {
    const one = removed.length === 1;
    throw new EveryAppError(
      "DURABLE_OBJECT_REMOVED",
      `Deploying would delete ${one ? `${removed[0]}'s data` : `the data of ${removed.join(", ")}`} for good\neveryapp.config.ts no longer declares the Durable Object class${one ? "" : "es"} ${removed.join(", ")}.`,
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
      `Deploying would delete the Workflow${one ? "" : "s"} ${removed.map((workflow) => workflow.binding).join(", ")} and ${one ? "its" : "their"} instances\neveryapp.config.ts no longer declares ${one ? "it" : "them"}. Renaming a binding renames its Workflow.`,
    );
  }
  return removed;
}

/** Returns the restore point saved before the database changed, if one was. */
async function migrate({
  cf,
  out,
  cwd,
  manifest,
  resources,
  accountId,
  registry,
  workerName,
  restoreCommand,
  appSecrets,
  drizzleKit,
  prisma,
}: {
  cf: CfRunner;
  out: EventSink;
  cwd: string;
  manifest: EveryAppCliManifest;
  resources: InstallTarget["resources"];
  accountId: string;
  /** Where the restore point is recorded. */
  registry: D1Database;
  workerName: string;
  /** How a person restores it. */
  restoreCommand: string;
  appSecrets: AppSecrets;
  drizzleKit?: MigrationCliRunner;
  prisma?: MigrationCliRunner;
}): Promise<Rollback | null> {
  if (manifest.migrations?.dialect === "postgresql") {
    await migratePostgresDatabase({ out, cwd, manifest, appSecrets, drizzleKit, prisma });
    return null;
  }
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length === 0) return null;
  const binding = resolveMigrationBinding(bindings, manifest.migrations);
  const databaseId = resources.d1?.[binding]?.id;
  const dir = path.resolve(cwd, migrationsDir(manifest));
  if (!databaseId || !(await directoryExists(dir))) {
    skipMigrations(out);
    return null;
  }
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "start",
    message: "Migrating the database...",
  });
  const result = await migrateRemoteD1({
    cf,
    databaseId,
    accountId,
    dir,
    registry,
    target: appRestoreTarget(workerName),
    restoreCommand,
  });
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "ok",
    message: result.applied.length > 0
      ? `Applied ${result.applied.join(", ")}.${restorePointNote(result.rollback)}`
      : "The app's database is up to date.",
    data: migrationEventData(result),
  });
  return result.rollback;
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
  drizzleKit?: MigrationCliRunner;
  prisma?: MigrationCliRunner;
}): Promise<void> {
  const engine = manifest.migrations?.engine === "prisma" ? "prisma" : "drizzle";
  const dir = engine === "drizzle" ? migrationsDir(manifest) : manifest.migrations?.dir;
  if (dir !== undefined && !(await directoryExists(path.resolve(cwd, dir)))) {
    skipMigrations(out);
    return;
  }
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "start",
    message: "Migrating the Postgres database...",
    data: { dialect: "postgresql", engine },
  });
  const migration = {
    cwd,
    // Checked before anything was created (deploySteps).
    databaseUrl: appSecrets[POSTGRES_URL_VARIABLE]!,
    config: manifest.migrations?.config,
  };
  // Prisma names the migrations it applied; drizzle-kit doesn't say.
  let applied: string[] | undefined;
  if (engine === "prisma") {
    applied = await migratePrismaPostgres({ ...migration, ...(prisma ? { run: prisma } : {}) });
  } else {
    await migratePostgres({ ...migration, ...(drizzleKit ? { run: drizzleKit } : {}) });
  }
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "ok",
    message: `Migrated the app's Postgres database (${engine === "prisma" ? "prisma migrate deploy" : "drizzle-kit migrate"}).`,
    data: { dialect: "postgresql", engine, ...(applied ? { applied } : {}) },
  });
}

/** The app has no migrations to apply. */
function skipMigrations(out: EventSink): void {
  out.emit({
    type: "step",
    step: "app.migrations",
    status: "skip",
    message: "No migrations to apply.",
  });
}
