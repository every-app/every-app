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
 *   3. under the app's deploy lease, the install engine the Gateway's
 *      browser installs run too (installApp, @every-app/perimeter/install
 *      app-install.ts), with `cf` as its port: claim the app's Workers,
 *      plan its Email Routing routes (the installation's inbound addresses,
 *      `everyapp email set --inbound`: checked before anything is created,
 *      Email Routing turned on for a domain only at a terminal or with
 *      --enable-email-routing), find or create its resources (only ever the
 *      app's own; a Hyperdrive config from the origin in the app's secrets
 *      file, lib/app/deploySecrets.ts), `cf build` the app (tenant-neutral:
 *      placeholders for everything install-specific), install the Build
 *      Output for this deploy and check it against the app policy and its
 *      Workflows' names, check that its drizzle migrations still describe
 *      its schema (steps/checkSchemaDrift.ts), make sure an unattended run
 *      may replace the Worker, and only then (the lease checked again
 *      before each) migrate D1 (bookmark, then `cf d1 migrations apply`),
 *      or Postgres (`drizzle-kit migrate`, lib/migrations/postgres.ts, or
 *      `prisma migrate deploy`, lib/migrations/prisma.ts), and upload the
 *      helper Workers (`workers`, `<worker>--<name>`), then the app's
 *      (`cf deploy --prebuilt`, with GATEWAY_URL and EVERY_APP_ORG_ID in
 *      the secrets file; cf creates or updates its Workflows), so a deploy
 *      that can't upload leaves the database alone. Workflows the app
 *      dropped (with --allow-delete-workflows) go once the upload is live,
 *      and its mail routes are made; then the registry records the
 *      version, its manifest and who deployed it (`pending` → `binding`);
 *   4. bind the Worker on the gateway and publish the app's hostname as a
 *      Workers Custom Domain if the install row says it doesn't yet (a
 *      reconcile: the live Gateway's own release, had again from where
 *      the install row says it came, lib/gateway/liveRelease.ts; what
 *      setup would deploy when it can't be, said so),
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
import { installApp } from "@every-app/perimeter/install";
import path from "node:path";
import { cliVersion } from "@/lib/version";
import { manifestTierProblems, validateManifestStrict, type GatewayNames } from "@every-app/perimeter/manifest";
import { capabilityIdsOf, providerIds, type AppSetup, type ProviderRegistry } from "@every-app/sdk/internal";
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
import { warnIfAccessNeedsRerun } from "@/lib/access/settings";
import { buildApp } from "@/lib/app/buildApp";
import {
  MISSING_CLOUDFLARE_CONFIG,
  readCloudflareConfig,
} from "@/lib/app/cloudflareConfig";
import type { InstallTarget } from "@every-app/perimeter/install";
import {
  APP_SECRETS_FILE,
  POSTGRES_URL_VARIABLE,
  readAppSecrets,
  type AppSecrets,
} from "@/lib/app/deploySecrets";
import { readBuildOutput, writeBuildOutput } from "@/lib/app/policy";
import { publicRoutesOf, type PublicRouteSummary } from "@/lib/app/publicRoutes";
import { describeAppOrigin, type AppRelease } from "@/lib/app/release";
import { recordUploadedVersion } from "@/lib/app/ownership";
import { resourceInstaller } from "@/lib/app/resources";
import {
  appSetupFrom,
  declaresSettings,
  describeUnmet,
  listGatewaySecretNames,
  namesToSet,
} from "@/lib/app/settings";
import { emailInstaller } from "@/lib/app/emailRoutes";
import type { D1Database } from "@/lib/cf/d1";
import { assertReplaceable, cfDeploy } from "@/lib/cf/deploy";
import { isCfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { deleteWorkflowIfExists, getWorkflow } from "@/lib/cf/workflows";
import { preflightAppHost } from "@/lib/domains/preflight";
import { afterMigration, EveryAppError, type Rollback } from "@/lib/errors";
import { directoryExists } from "@/lib/file-operations";
import { connectToGateway } from "@/lib/gateway/connect";
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
import { CLI, thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, type Confirm } from "@/lib/output/prompt";
import { listed } from "@/lib/output/text";
import { installDependencies } from "@/lib/package-manager";
import { warnSdkVersion } from "@/lib/app/sdkVersion";
import { readBundledProviderSpecs, releasedProviderSpecs } from "@/lib/app/bundledProviders";
import { registerBundledProviders } from "./steps/bundledProviders";

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
   * `--register-providers`: register the providers the app bundles
   * (`.everyapp/providers`, a release's `providers`) without asking.
   * `--yes` alone doesn't: a bundled spec names the hosts the operator's
   * key will go to, so an agent's habitual `--yes` must not approve it.
   */
  registerProviders?: boolean;
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
  // A Gateway installed on the way comes from where setup takes it (no install row yet).
  const setupGateway = gatewayFor(options.reconcile, null, out, options.verbose);
  out.emit({ type: "step", step: "app.connect", status: "start", message: "Finding your Gateway..." });
  const { cf, accountId, accountName, databaseId, names, db: registry, install, gatewayUrl, deployer } =
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
                  ...setupDeps({ gateway: setupGateway, interactive }),
                  ...(options.createCf ? { createCf: options.createCf } : {}),
                  ...offer.setup,
                },
              },
            })
        : undefined,
    });
  out.emit({ type: "step", step: "app.connect", status: "ok", data: { gatewayUrl } });
  // The providers the app bundles (`.everyapp/providers`, or a release's
  // `providers`), registered after one confirmation, before the manifest
  // is checked against the registry they join.
  const bundled = await registerBundledProviders({
    specs: release ? releasedProviderSpecs(release.release.providers) : await readBundledProviderSpecs(cwd),
    appId: manifest.id,
    db: registry,
    install,
    deployer,
    gatewayUrl,
    out,
    interactive,
    registerProviders: options.registerProviders,
    confirm: options.confirm,
  });
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
  // The Gateway a rebind deploys: the live one again. A deploy that will
  // bind the app refuses before anything is registered when it can't be
  // had (GATEWAY_RELEASE_UNAVAILABLE); a redeploy of a bound app needs none.
  const gateway = gatewayFor(options.reconcile, install, out, options.verbose);
  if (!registered || !install.liveAppWorkers.includes(registered.workerName)) await gateway.source();
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
  const { plan, organization, hasOwner } = await registerFromManifest(
    registry,
    { manifest, install, names, deployer, accountName },
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
  // it; what the manifest opens to the internet it says every time; so
  // does the manifest's `ai.routes` (OpenAI paths beyond inference on the
  // Gateway's shared key: the manifest is their grant, so the deploy shows
  // them).
  const publicRoutes = publicRoutesOf(manifest);
  const aiRoutes = manifest.ai?.routes ?? [];
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
      defaultAccess: plan.app.everyone,
      hasOwner,
      publicRoutes,
      ...(aiRoutes.length > 0 ? { aiRoutes } : {}),
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
    names,
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
  let next: DeployAppResult["next"];
  try {
    const replace = {
      question: "Replace the version that's serving?",
      effect: "Migrations run first.",
    };
    const installed = await installApp(
      {
        manifest,
        previousManifest: plan.previousManifest,
        workerName,
        resources: plan.resources,
        recordedVersionId: plan.versionId,
        organizationId: organization.id,
        accountId,
        gatewayUrl,
        gatewayWorker: names.worker,
        identityPublicKeys: [identityKey],
        secrets: appSecrets,
        readEmail: () => readAppEmail(registry, plan.app.id),
        // The installation's senders are its own to set, on a Gateway that takes them.
        sendersSettable:
          emailInstaller.emailDeclarations(manifest).sends && install.deploymentMode !== "hosted",
        interactive,
        confirm: options.confirm,
        enableEmailRouting: options.enableEmailRouting,
        allowDeleteDurableObjectData: options.allowDeleteDurableObjectData,
        allowDeleteWorkflows: options.allowDeleteWorkflows,
      },
      {
        cf,
        db: registry,
        out,
        CLI,
        thisCommand: () => thisCommand(),
        resources: resourceInstaller,
        email: emailInstaller,
        getWorkflow,
        deleteWorkflow: async (cf, name) => {
          await deleteWorkflowIfExists(cf, name);
        },
        workerSecretNames: async (cf, name) => {
          try {
            return await listWorkerSecrets(cf, name);
          } catch (error) {
            if (isCfError(error, "not_found")) return [];
            throw error;
          }
        },
        build: release
          ? undefined
          : async () => {
              if (manifest.install !== false) {
                out.emit({ type: "step", step: "app.install", status: "start", message: "Installing dependencies..." });
                await (options.installDeps ?? installDependencies)({
                  cwd,
                  description: "Installing dependencies...",
                  install: manifest.install,
                  verbose: options.verbose ?? false,
                });
                out.emit({ type: "step", step: "app.install", status: "ok" });
              }
              warnSdkVersion(cwd, out);
              out.emit({ type: "step", step: "app.build", status: "start", message: "Building..." });
              await buildApp({
                cwd,
                cf,
                buildCommand: manifest.build,
                verbose: options.verbose ?? false,
              });
            },
        readBuildOutput: () => readBuildOutput(root),
        writeBuildOutput: (workers) => writeBuildOutput(root, workers),
        built: async (workflows) => {
          out.emit({
            type: "step",
            step: "app.build",
            status: "ok",
            message: `${release ? "Installed the release" : "Built the app"} and checked its Worker${manifest.workers?.length ? "s" : ""}.`,
            data: { release: release !== undefined, workflows },
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
        },
        replaceable: (worker) =>
          assertReplaceable({ cf, ...worker, interactive, confirm: options.confirm, change: replace }),
        migrate: async (resources) => {
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
        },
        upload: async (worker, values) => {
          const uploaded = await cfDeploy({
            cf,
            cwd: root,
            workerName: worker.workerName,
            ...(worker.helper ? { buildOutputWorker: worker.workerName } : {}),
            accountId,
            message: `everyapp ${cliVersion} ${manifest.id}${worker.helper ? ` ${worker.helper}` : ""}`,
            secrets: { ...values },
            interactive,
            attach: out.verbose,
            out,
            step: worker.helper ? "app.helper" : "app.upload",
            // Recorded at once, before the registry hears of it: a retry
            // must find this upload was everyapp's, however this run ends.
            onUploaded: (uploadedVersion) =>
              recordUploadedVersion(registry, workerName, uploadedVersion, worker.helper),
          });
          return uploaded.versionId;
        },
        checkpoint: () => lease.check(),
      },
    ).catch((error: unknown) => {
      throw EveryAppError.fromInstallation(error);
    });
    versionId = installed.versionId;
    next = installed.next;
    const { secretNames } = installed;
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
    const setup = await warnIfNeedsSetup({ cf, gateway: names, manifest, appId: manifest.id, secretNames, out, next, providers });
    await recordSetupStateQuietly(registry, { appRowId: plan.app.id, setup, deployer }, out);
  } finally {
    await lease.release();
  }

  // 4. Bind and publish under the gateway's lease, then go live.
  await bindIfNeeded({
    cf,
    db: registry,
    databaseId,
    names,
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
  // A deploy never changes Cloudflare Access: `access on` lets public
  // routes through. Said when this deploy changed them and Access is on.
  await warnIfAccessNeedsRerun(
    { cf, out, worker: names.worker },
    {
      appId: manifest.id,
      previous: plan.previousManifest,
      next: manifest,
      message: `Cloudflare Access doesn't know ${manifest.id}'s new public routes yet\nUntil ${CLI} access on runs again, they need an Access sign-in.`,
    },
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
  gateway,
  manifest,
  appId,
  secretNames,
  out,
  next,
  providers,
}: {
  cf: CfRunner;
  /** The Gateway's names: its Worker holds the settings. */
  gateway: GatewayNames;
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
  const gatewayNames = await listGatewaySecretNames(cf, gateway).catch(() => null);
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
  // The AI providers under `providers` too: the catalog's `ai` entries and
  // the registered `ai` rows (an OpenAI-compatible spec).
  const unknownProviders = providerIds(manifest).filter((id) => providers.get(id)?.mode !== "ai");
  if (unknownProviders.length > 0) {
    const offered = providers.ids().filter((id) => providers.get(id)?.mode === "ai" && !("kind" in providers.get(id)!));
    throw new EveryAppError(
      "CAPABILITY_UNKNOWN",
      [
        `${manifest.id} lists ${listed(unknownProviders)} under providers, which ${gatewayUrl.replace(/^https:\/\//, "")} doesn't offer as a model provider`,
        `Neither the built-in catalog nor the providers registered on this Gateway ${unknownProviders.length === 1 ? "has it" : "have them"}. It offers: ${offered.join(", ")}.`,
      ].join("\n"),
      {
        fix: `register ${unknownProviders.length === 1 ? "it" : "each"} with ${CLI} provider add <spec.json> (an OpenAI-compatible provider is a spec with mode "ai"; or fix the id in everyapp.config.ts), then deploy again`,
        data: { unknown: unknownProviders, offered },
      },
    );
  }
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
    { fix: `clone it, run pnpm install in it, then ${CLI} deploy from its directory` },
  );
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
