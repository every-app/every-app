/**
 * Deploying the gateway, shared by `everyapp setup` (install, upgrade,
 * repair; ./source.ts picks the release) and the rebind of `deploy` and
 * `delete`, which deploys the live release again (./liveRelease.ts) and
 * so never changes the Gateway's code.
 *
 * Under the `gateway` deploy lease, in this order:
 *
 *   1. check the release isn't older than the live one, which the install
 *      row names;
 *   2. a new install's row (or one whose first upload never finished),
 *      with nothing live yet, so a run that stops before its first upload
 *      resumes from it without --domain;
 *   3. unless this is a reconcile with the release that is live, check what
 *      could stop the upload: the release patches into a valid Build
 *      Output, and the Worker serves a version everyapp recorded (cf's
 *      strict mode) or a person agrees to replace it. A Worker that holds
 *      the row's own hostname as a Custom Domain while the row records no
 *      version is this install's own upload, from a run that stopped
 *      after it (a workers.dev subdomain to register): replaced without
 *      asking. A database migrated under old code that keeps serving is
 *      what a failed upgrade must not leave behind;
 *   4. (likewise) migrate the gateway's D1 — bookmark, then
 *      `cf d1 migrations apply` — so a failed migration leaves the gateway
 *      that is serving untouched;
 *   5. read which app Workers the registry says to bind, and their hosts;
 *   6. patch a private copy of the release's Build Output with them and
 *      this install's ids and domains (each app host a Workers Custom
 *      Domain), validated with cf's schema;
 *   7. check every hostname it adds (lib/domains/preflight.ts: DNS
 *      records that answer it, the zone's limit), before the database
 *      changes when it can, and always before the upload;
 *   8. `cf deploy --prebuilt`, once: with the secrets file on a first
 *      upload (no Worker yet, or none the row recorded), and the install
 *      row recorded as soon as the upload is known
 *      (on the way out of a Ctrl+C too), with the public half of any
 *      identity key pair the upload sets. The hostnames are recorded only
 *      once cf has published them: when it stops after the upload, only
 *      the version is (record()). An app that registers meanwhile is bound
 *      by its own deploy's rebind, which waits for this lease.
 *
 * Nothing is asked of the gateway over HTTPS: what cf deployed and the
 * install row are the record. The caller waits for the new hostnames'
 * certificates once the lease is free (`newHosts`). Under the lease,
 * nothing replaces the release the install row names with an older one
 * unless asked to.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import type { D1Database } from "@/lib/cf/d1";
import { assertReplaceable, cfDeploy } from "@/lib/cf/deploy";
import { privateTempDir } from "@/lib/cf/privateDir";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment, workerCustomDomains } from "@/lib/cf/workers";
import { publishedAppHosts } from "@/lib/domains/hostnames";
import { preflightDomains } from "@/lib/domains/preflight";
import { afterMigration, EveryAppError, type Rollback } from "@/lib/errors";
import type { Confirm } from "@/lib/output/prompt";
import {
  migrateRemoteD1,
  migrationEventData,
  restorePointNote,
} from "@/lib/migrations/remote";
import { GATEWAY_RESTORE_TARGET } from "./restorePoints";
import { CLI, thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { plural } from "@/lib/output/text";
import {
  readDesiredState,
  workerExistence,
  type DesiredState,
} from "./desiredState";
import { readInstall, writeInstall, type InstallRecord } from "./install";
import { acquireGatewayLease, LeasePurpose, type Lease } from "./lease";
import { gatewayDomains, patchGatewayBuildOutput } from "./patchBuildOutput";
import {
  compareReleaseOrder,
  describeOrigin,
  type CandidateRelease,
  type GatewayRelease,
} from "./release";
import type { GatewayResources } from "./resources";
import { newGatewaySecrets, type DeploymentMode } from "./secretsFile";

type ApplyReason = "deploy" | "upgrade" | "reconcile";

/** The hostnames the install row says the gateway is published under. */
type Publication = Pick<InstallRecord, "liveDomains">;

/** What the install row recorded before this run: its publication, and whether an upload ever was. */
type Recorded = Publication & Pick<InstallRecord, "liveVersionId">;

export interface ApplyGatewayOptions {
  cf: CfRunner;
  out: EventSink;
  reason: ApplyReason;
  release: GatewayRelease;
  accountId: string;
  gatewayHost: string;
  zone: { id: string; name: string };
  /** Where app hosts live; the gateway host. */
  appBaseDomain: string;
  resources: GatewayResources;
  db: D1Database;
  /** Publish new hostnames over the DNS records that answer them (--force-dns). */
  forceDns?: boolean;
  /**
   * Hostnames the caller checked already (lib/domains/preflight.ts), before
   * it said anything was starting: setup's own host.
   */
  checkedDomains?: readonly string[];
  /** A person at a terminal answers cf's own prompts. */
  interactive: boolean;
  /** Asks that person before replacing a version everyapp didn't record (tests). */
  confirm?: Confirm;
  cliVersion: string;
  /** Gateway settings sent with the upload (tests; `everyapp secret set` changes the live Worker instead). */
  stagedSecrets?: Record<string, string>;
  /**
   * GATEWAY_DEPLOYMENT_MODE for a Worker's first upload (default
   * `self_hosted`) when the install row records none; later uploads keep
   * the one it has.
   */
  deploymentMode?: DeploymentMode;
  /** The gateway lease the caller holds (a reconcile picks its release under it). */
  heldLease?: Lease;
  /** Deploy a release older than the one the install record names. */
  allowDowngrade?: boolean;
  /** The command takes --allow-downgrade (setup): a refusal offers it. */
  allowDowngradeFlag?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for another deploy's lease. */
  leaseWaitMs?: number;
}

export interface ApplyGatewayResult {
  versionId: string | null;
  firstDeploy: boolean;
  appWorkers: string[];
  /** Every hostname the gateway is published under now. */
  domains: string[];
  /** Hostnames this run published for the first time: they wait for certificates. */
  newHosts: string[];
}

/** The lease purpose of each reason the Gateway is deployed. */
const GATEWAY_LEASE_PURPOSES: Readonly<Record<ApplyReason, LeasePurpose>> = {
  deploy: LeasePurpose.GatewayDeploy,
  upgrade: LeasePurpose.GatewayUpgrade,
  reconcile: LeasePurpose.GatewayReconcile,
};

/** What the guard knows of a release this run opened. */
export function candidate(release: GatewayRelease): CandidateRelease {
  return {
    ...release.source,
    version: release.manifest.version,
    sha256: release.manifest.sha256,
    minCli: release.manifest.minCli,
  };
}

/**
 * Whether a release is the one the install row says is live: the same
 * bytes, or a build of the same sources. Builds aren't reproducible (two
 * builds of one tree name their client chunks differently), so another
 * machine at the same commit builds another SHA-256 of the same Gateway.
 */
export function isLiveRelease(
  release: GatewayRelease,
  install: InstallRecord,
): boolean {
  if (install.liveVersionId === null) return false;
  return (
    release.manifest.sha256 === install.releaseSha256 ||
    (release.source.treeSha256 !== null &&
      release.source.treeSha256 === install.sourceTreeSha256)
  );
}

/**
 * Whether a Gateway (this checkout's, or a release's) is older than the
 * one the install row says is live: not the same release or the same sources, and earlier in
 * the history (`compareReleaseOrder`: its newest migration, then when its
 * sources were last committed).
 */
export function olderThanInstalled(
  release: CandidateRelease,
  install: InstallRecord,
): boolean {
  if (release.sha256 && release.sha256 === install.releaseSha256) return false;
  if (release.treeSha256 && release.treeSha256 === install.sourceTreeSha256) {
    return false;
  }
  return compareReleaseOrder(release.order, install.releaseOrder) < 0;
}

/** Throw DOWNGRADE_REFUSED when `release` is older than the live Gateway. */
export function refuseDowngrade(
  release: CandidateRelease,
  install: InstallRecord,
  options: { allowDowngradeFlag?: boolean } = {},
): void {
  if (olderThanInstalled(release, install)) {
    throw downgradeRefused(release, install, options);
  }
}

/**
 * This checkout is behind the live Gateway: `git pull`, then the same
 * command; a release is: a newer one, or a checkout at least as new. Only
 * `setup` puts an older Gateway back on purpose, with --allow-downgrade
 * (`allowDowngradeFlag`), which an agent asks about first.
 */
function downgradeRefused(
  release: CandidateRelease,
  install: InstallRecord,
  { allowDowngradeFlag = false }: { allowDowngradeFlag?: boolean } = {},
): EveryAppError {
  // The versions alone, unless they are the same: then when each is from.
  const sameVersion = release.version === install.releaseVersion;
  const from = (order: { committedAt: number }) =>
    new Date(order.committedAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const checkout = release.origin.kind === "checkout";
  const what = checkout
    ? "This checkout's Gateway"
    : `The Gateway from ${describeOrigin(release.origin)}`;
  const message = sameVersion
    ? `${what} (${release.version} from ${from(release.order)}) is older than the live one (from ${from(install.releaseOrder)})`
    : `${what} (${release.version}) is older than the live one (${install.releaseVersion})`;
  const data = { live: install.releaseVersion, candidate: release.version };
  // Only setup puts an older Gateway back, and only when asked to.
  if (allowDowngradeFlag) {
    return new EveryAppError("DOWNGRADE_REFUSED", message, {
      fix: checkout
        ? "git pull, then run setup again"
        : "pass --release a newer Gateway release",
      rerun: thisCommand(["--allow-downgrade"]),
      authorize: true,
      data,
    });
  }
  return new EveryAppError("DOWNGRADE_REFUSED", message, {
    fix: checkout ? "git pull" : "run everyapp from a checkout at least as new",
    rerun: thisCommand(),
    rerunNote: "after that",
    data,
  });
}

/**
 * The hostnames a deploy checks before publishing them: each one once per
 * run, and never one the install already serves.
 */
class DomainChecks {
  private readonly checked: Set<string>;
  private readonly warned = new Set<string>();

  constructor(
    private readonly options: ApplyGatewayOptions,
    readonly liveDomains: readonly string[],
  ) {
    this.checked = new Set(options.checkedDomains);
  }

  /** The domains the gateway publishes for these app hosts. */
  domainsFor(appHosts: readonly string[]): string[] {
    const { appBaseDomain, gatewayHost, out } = this.options;
    const published = publishedAppHosts(appHosts, appBaseDomain);
    const stray = appHosts.filter((host) => !published.includes(host));
    const unwarned = stray.filter((host) => !this.warned.has(host));
    if (unwarned.length > 0) {
      out.emit({
        type: "warning",
        code: "APP_HOST_OUTSIDE_BASE",
        message: `Skipping ${unwarned.join(", ")}: ${unwarned.length === 1 ? "it isn't" : "they aren't"} under ${appBaseDomain}\nApps live one level below the Gateway's domain (<name>.${appBaseDomain}).`,
        data: { hosts: unwarned },
      });
      for (const host of unwarned) this.warned.add(host);
    }
    return gatewayDomains({ gatewayHost, appHosts: published });
  }

  async check(domains: readonly string[]): Promise<void> {
    await preflightDomains({
      cf: this.options.cf,
      out: this.options.out,
      step: "gateway.domains",
      zone: this.options.zone,
      domains,
      liveDomains: [...this.liveDomains, ...this.checked],
      forceDns: this.options.forceDns,
      cfAsks: this.options.interactive && this.options.out.verbose,
    });
    for (const host of domains) this.checked.add(host);
  }
}

export async function applyGateway(
  options: ApplyGatewayOptions,
): Promise<ApplyGatewayResult> {
  const { cf, reason, release, db } = options;
  const ownLease = options.heldLease
    ? null
    : await acquireGatewayLease(options, GATEWAY_LEASE_PURPOSES[reason]);
  const lease = options.heldLease ?? ownLease!;
  // Once the database is migrated, a failure says how to put it back.
  let rollback: Rollback | null = null;
  try {
    // Only now is the install record the last deploy's for sure: another
    // upgrade may have finished while this one waited for the lease.
    const install = await readInstall(db);
    if (install && !options.allowDowngrade) {
      refuseDowngrade(candidate(release), install, {
        allowDowngradeFlag: options.allowDowngradeFlag,
      });
    }
    // A Worker holding the row's hostname while the row names no version:
    // this install's own upload, from a run that stopped after it. Skipping
    // assertReplaceable's question isn't a silent takeover: one edited in
    // the dashboard since the stop is still cf's strict mode's to refuse
    // (unattended: strict_conflict → rerun_interactive; at a terminal cf
    // asks), after a migration that is a no-op on an install that never
    // finished.
    const ownUpload =
      install !== null &&
      install.liveVersionId === null &&
      (await workerCustomDomains(cf, GATEWAY_WORKER_NAME)).includes(
        install.gatewayHost.toLowerCase(),
      );
    if (!install || install.liveVersionId === null) {
      // A new install is recorded before anything can stop it, so a run
      // that does (a DNS record in the way, no workers.dev subdomain yet)
      // resumes from the row, without --domain. Nothing is live yet, so a
      // run that never got further may still change where it goes.
      await writeInstall(
        db,
        installRecord(options, {
          liveVersionId: null,
          liveDomains: [],
          liveAppWorkers: [],
          jwtPublicKey: null,
          deploymentMode: null,
        }),
      );
    }
    const domainChecks = new DomainChecks(options, install?.liveDomains ?? []);
    const workerExists = workerExistence(cf);
    // A reconcile with the release that is live only rebinds; any other
    // deploy brings the database up to this release first.
    const sameRelease = install !== null && isLiveRelease(release, install);
    if (reason !== "reconcile" || !sameRelease) {
      // Before migrating: the registry's newest columns may not exist yet,
      // so no app is bound in this check, and only the hosts a migrated
      // registry already lists are checked.
      await withPatchedRelease(options, { appWorkers: [], appHosts: [] }, async () => undefined);
      const registered = await readDesiredState(db, workerExists).catch(
        () => null,
      );
      await domainChecks.check(domainChecks.domainsFor(registered?.appHosts ?? []));
      if (ownUpload) {
        options.out.emit({
          type: "step",
          step: "gateway.resume",
          status: "ok",
          message: `Replacing the Gateway an earlier run uploaded at ${install.gatewayHost}\nThat run stopped before it could finish; nothing uses that upload yet.`,
          data: { gatewayHost: install.gatewayHost },
        });
      } else {
        await assertReplaceable({
          cf,
          workerName: GATEWAY_WORKER_NAME,
          shownAs: "the Gateway",
          recordedVersionIds: [install?.liveVersionId],
          interactive: options.interactive,
          confirm: options.confirm,
          change: {
            question: `Replace it with ${release.manifest.version}?`,
            // Even an upgrade: an upgrade to a newer release yet may have
            // stopped before recording itself.
            effect:
              "If it runs a newer release (an upgrade that stopped before recording itself), this puts an older one back.",
          },
        });
      }
      await lease.check();
      rollback = await migrate(options);
    }
    // A mode the install row records is the gateway's for good: a Worker
    // that comes back (deleted by hand) gets the one it was installed with.
    const deploymentMode = install?.deploymentMode ?? options.deploymentMode;
    return await deploy({ ...options, deploymentMode }, domainChecks, workerExists, {
      liveDomains: install?.liveDomains ?? [],
      liveVersionId: install?.liveVersionId ?? null,
    }, lease);
  } catch (error) {
    throw afterMigration(error, rollback);
  } finally {
    await ownLease?.release();
  }
}

/** Returns the restore point saved before the database changed, if one was. */
async function migrate({
  cf,
  out,
  resources,
  release,
  accountId,
  db,
}: ApplyGatewayOptions): Promise<Rollback | null> {
  out.emit({
    type: "step",
    step: "gateway.migrations",
    status: "start",
    message: "Migrating the Gateway's database",
  });
  const result = await migrateRemoteD1({
    cf,
    databaseId: resources.d1Id,
    accountId,
    dir: path.join(release.dir, "drizzle"),
    registry: db,
    target: GATEWAY_RESTORE_TARGET,
    restoreCommand: `${CLI} db restore --gateway`,
  });
  out.emit({
    type: "step",
    step: "gateway.migrations",
    status: "ok",
    message: result.fresh
      ? "Database created"
      : result.applied.length > 0
        ? `Applied ${plural(result.applied.length, "migration")}.${restorePointNote(result.rollback)}`
        : "Database up to date",
    data: migrationEventData(result),
  });
  return result.rollback;
}

/**
 * One upload, binding what the registry says now. No second one follows
 * when the registry changes meanwhile: whatever changes it (an app's deploy
 * or delete) rebinds the gateway itself, under this same lease, once this
 * deploy frees it.
 */
async function deploy(
  options: ApplyGatewayOptions,
  domainChecks: DomainChecks,
  workerExists: (workerName: string) => Promise<boolean>,
  /** What the install row records before this run. */
  recorded: Recorded,
  /** Checked before the upload. */
  lease: Lease,
): Promise<ApplyGatewayResult> {
  const { cf, out, release, db, gatewayHost } = options;
  const firstDeploy =
    (await getWorkerDeployment(cf, GATEWAY_WORKER_NAME)) === null;
  // The row's first upload: no Worker yet, or one the row never recorded
  // (its own, from a run that stopped; or one a person agreed to replace).
  const firstUpload = firstDeploy || recorded.liveVersionId === null;
  const desired = await readDesiredState(db, workerExists);
  for (const row of desired.skipped) {
    out.emit({
      type: "warning",
      code: "APP_NOT_BOUND",
      message: `Skipping ${row.appId}: its Worker isn't the one everyapp registered\nSo the Gateway won't route to it.`,
      data: {
        appId: row.appId,
        workerName: row.workerName,
        fix: `deploy ${row.appId} again, or remove it with ${CLI} delete ${row.appId}`,
      },
    });
  }
  for (const row of desired.missing) {
    out.emit({
      type: "warning",
      code: "APP_WORKER_MISSING",
      message: `Skipping ${row.appId}: its Worker is missing\nIt was deleted by hand or never uploaded, so the Gateway won't route to it.`,
      data: {
        appId: row.appId,
        workerName: row.workerName,
        fix: `deploy ${row.appId} again, or remove it with ${CLI} delete ${row.appId}`,
      },
    });
  }
  const domains = domainChecks.domainsFor(desired.appHosts);
  await domainChecks.check(domains);
  await lease.check();
  out.emit({
    type: "step",
    step: "gateway.deploy",
    status: "start",
    message: `Uploading Gateway ${release.manifest.version} with ${plural(desired.appWorkers.length, "app")}`,
    data: { appWorkers: desired.appWorkers, domains },
  });
  // A Worker without a version the row knows gets a new identity key pair
  // and its deployment mode, and the install row the public half and the
  // mode with the upload, for the apps' deploys to hand their Workers and
  // status to show.
  const deploymentMode = options.deploymentMode ?? "self_hosted";
  const keys = firstUpload
    ? newGatewaySecrets({
        gatewayUrl: `https://${gatewayHost}`,
        accountId: options.accountId,
        deploymentMode,
      })
    : null;
  const deployed = await upload(options, desired, domains, {
    before: recorded,
    secrets: { ...keys?.secrets, ...options.stagedSecrets },
    jwtPublicKey: keys?.jwtPublicKey ?? null,
    deploymentMode: keys ? deploymentMode : null,
  });
  const newHosts = domains.filter((host) => !domainChecks.liveDomains.includes(host));
  out.emit({
    type: "step",
    step: "gateway.deploy",
    status: "ok",
    message: deployed.versionId ? `Uploaded version ${deployed.versionId}` : "Uploaded",
    data: { versionId: deployed.versionId },
  });
  return {
    versionId: deployed.versionId,
    firstDeploy,
    appWorkers: desired.appWorkers,
    domains,
    newHosts,
  };
}

function upload(
  options: ApplyGatewayOptions,
  desired: DesiredState,
  domains: string[],
  {
    before,
    secrets,
    jwtPublicKey,
    deploymentMode,
  }: {
    /** What stays recorded if cf stops after the upload. */
    before: Publication;
    secrets: Record<string, string>;
    /**
     * The identity key's public half, whenever this upload sets a new pair:
     * the install row must name the key the gateway signs with.
     */
    jwtPublicKey: string | null;
    /** The deployment mode, whenever this upload sets it (a first one). */
    deploymentMode: DeploymentMode | null;
  },
): Promise<{ versionId: string | null; output: string }> {
  return withPatchedRelease(options, desired, (workdir) =>
    cfDeploy({
      cf: options.cf,
      cwd: workdir,
      workerName: GATEWAY_WORKER_NAME,
      accountId: options.accountId,
      message: `everyapp ${options.cliVersion} gateway ${options.release.manifest.version} (${options.reason})`,
      secrets,
      interactive: options.interactive,
      attach: options.out.verbose,
      cliCf: true,
      out: options.out,
      step: "gateway.deploy",
      onUploaded: (versionId, finished) =>
        record(
          options,
          desired,
          versionId,
          finished ? { liveDomains: domains } : before,
          { jwtPublicKey, deploymentMode },
        ),
    }),
  );
}

/** A private copy of the release, patched for this install and these apps. */
async function withPatchedRelease<T>(
  options: ApplyGatewayOptions,
  apps: Pick<DesiredState, "appWorkers" | "appHosts">,
  use: (workdir: string) => Promise<T>,
): Promise<T> {
  // cf runs in this copy, so it lives where no one else can plant a
  // cloudflare.config.ts above it (lib/cf/privateDir.ts).
  const { dir: workdir, cleanup } = await privateTempDir("gateway-deploy-");
  try {
    await fs.cp(options.release.dir, workdir, { recursive: true });
    await patchGatewayBuildOutput(workdir, {
      d1Id: options.resources.d1Id,
      oauthKvId: options.resources.oauthKvId,
      release: {
        version: options.release.manifest.version,
        sha256: options.release.manifest.sha256,
      },
      gatewayHost: options.gatewayHost,
      appBaseDomain: options.appBaseDomain,
      appWorkers: apps.appWorkers,
      // Only hosts one label below the base: see DomainChecks.domainsFor.
      appHosts: publishedAppHosts(apps.appHosts, options.appBaseDomain),
    });
    return await use(workdir);
  } finally {
    await cleanup();
  }
}

/**
 * Record the version that went live: its release and the apps it binds,
 * and `publication`, the hostnames the gateway is published under. That is
 * this deploy's once cf finished. When cf stopped after the upload (it
 * couldn't publish a hostname: a move from another Worker declined, the
 * zone's limit, an API error; or Ctrl+C), it is what was recorded before:
 * the next deploy then checks this one's new hostnames again (DNS records,
 * who may hold them). The identity key's public half and the deployment
 * mode only when this upload set them (a first one); otherwise the row
 * keeps the ones it has.
 */
function record(
  options: ApplyGatewayOptions,
  desired: DesiredState,
  versionId: string | null,
  publication: Publication,
  firstSecrets: Pick<InstallRecord, "jwtPublicKey" | "deploymentMode">,
): Promise<void> {
  return writeInstall(
    options.db,
    installRecord(options, {
      liveVersionId: versionId,
      liveDomains: publication.liveDomains,
      liveAppWorkers: desired.appWorkers,
      ...firstSecrets,
    }),
  );
}

/** This install, with this release, and what is live. */
function installRecord(
  options: ApplyGatewayOptions,
  live: Pick<
    InstallRecord,
    | "liveVersionId"
    | "liveDomains"
    | "liveAppWorkers"
    | "jwtPublicKey"
    | "deploymentMode"
  >,
): InstallRecord {
  return {
    accountId: options.accountId,
    zoneId: options.zone.id,
    zoneName: options.zone.name,
    gatewayHost: options.gatewayHost,
    appBaseDomain: options.appBaseDomain,
    oauthKvId: options.resources.oauthKvId,
    releaseVersion: options.release.manifest.version,
    releaseSha256: options.release.manifest.sha256,
    releaseOrder: options.release.source.order,
    sourceTreeSha256: options.release.source.treeSha256,
    releaseOrigin: options.release.source.origin,
    releaseGitSha: options.release.manifest.gitSha,
    ...live,
    updatedAt: Date.now(),
    updatedBy: `everyapp ${options.cliVersion} on ${os.hostname()}`,
  };
}
