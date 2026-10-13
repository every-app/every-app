/**
 * Deploying the gateway, shared by `everyapp gateway deploy|upgrade|reconcile`.
 *
 * Under the `gateway` deploy lease, in this order:
 *
 *   0. (deploy, upgrade) check what could stop the upload: the release
 *      patches into a valid Build Output, isn't older than the live one,
 *      and the Worker serves a version everyapp recorded (cf's strict mode)
 *      or a person agrees to replace it. A database migrated under old code
 *      that keeps serving is what a failed upgrade must not leave behind;
 *   1. (deploy, upgrade) migrate the gateway's D1 — bookmark, carry
 *      drizzle-kit's history over once, `cf d1 migrations apply` — so a
 *      failed migration leaves the gateway that is serving untouched;
 *   2. (deploy, upgrade) cache the release in the deploy KV namespace;
 *   3. read which app Workers the registry says to bind;
 *   4. patch a private copy of the release's Build Output with them and
 *      this install's ids, domain and route, validated with cf's schema;
 *   5. `cf deploy --prebuilt`, with the secrets file on a first deploy,
 *      and record the install row as soon as the upload is known (on the
 *      way out of a Ctrl+C too);
 *   6. wait for /api/deploy/status to report the new release and bindings;
 *   7. if the registry changed meanwhile (an app registered), go again.
 *
 * Reconcile redeploys exactly the release that is live, fetched from the
 * cache and checked against its SHA-256, so binding a new app never
 * upgrades or downgrades the gateway. Under the lease, nothing replaces the
 * release the install record names with an older one unless asked to.
 */
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import type { D1Database } from "@/lib/cf/d1";
import { assertReplaceable, cfDeploy, type Confirm } from "@/lib/cf/deploy";
import { makeCfTempDir } from "@/lib/cf/privateDir";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { EveryAppError } from "@/lib/errors";
import { onInterrupt } from "@/lib/interrupt";
import { writeCachedInstall } from "@/lib/install/state";
import { migrateRemoteD1 } from "@/lib/migrations/remote";
import type { EventSink } from "@/lib/output/events";
import { GatewayClient, type GatewayStatusResponse } from "./api";
import {
  readDesiredState,
  sameBindings,
  workerExistence,
  type DesiredState,
} from "./desiredState";
import { readInstall, writeInstall, type InstallRecord } from "./install";
import { acquireLease, type BreakLease } from "./lease";
import { patchGatewayBuildOutput } from "./patchBuildOutput";
import {
  cacheRelease,
  compareReleaseOrder,
  compareVersions,
  knownRelease,
  releaseOrder,
  servingReleaseSha256,
  type GatewayRelease,
} from "./release";
import type { GatewayResources } from "./resources";
import { firstDeploySecrets } from "./secretsFile";

type ApplyReason = "deploy" | "upgrade" | "reconcile";

const MAX_DEPLOYS = 3;
const VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_INTERVAL_MS = 3_000;

type StatusReader = (gatewayUrl: string) => Promise<GatewayStatusResponse>;

export interface ApplyGatewayOptions {
  cf: CfRunner;
  out: EventSink;
  reason: ApplyReason;
  release: GatewayRelease;
  accountId: string;
  gatewayHost: string;
  zone: { id: string; name: string };
  resources: GatewayResources;
  db: D1Database;
  /** A person at a terminal answers cf's own prompts. */
  interactive: boolean;
  /** Asks that person before replacing a version everyapp didn't record (tests). */
  confirm?: Confirm;
  cliVersion: string;
  /** Settings from `everyapp gateway secret set`, sent with the upload. */
  stagedSecrets?: Record<string, string>;
  /** Asked whether to take the lease from a deploy that holds it (`--break-lease`). */
  breakLease?: BreakLease;
  /** The caller holds the gateway lease (a reconcile picks its release under it). */
  leaseHeld?: boolean;
  /** Deploy a release older than the one the install record names. */
  allowDowngrade?: boolean;
  /** Patch and `cf deploy --dry-run` only: no lease, no writes. */
  dryRun?: boolean;
  readStatus?: StatusReader;
  sleep?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  /** How long to wait for another deploy's lease. */
  leaseWaitMs?: number;
}

export interface ApplyGatewayResult {
  versionId: string | null;
  firstDeploy: boolean;
  appWorkers: string[];
  /** The live gateway confirmed it serves this release and these bindings. */
  verified: boolean;
  /** cf's binding table, after a dry run. */
  dryRunOutput?: string;
}

const readPublicStatus: StatusReader = (gatewayUrl) =>
  new GatewayClient({ gatewayUrl }).status();

/** Take the `gateway` deploy lease, saying who has it while waiting. */
export function acquireGatewayLease(
  options: Pick<
    ApplyGatewayOptions,
    "db" | "out" | "breakLease" | "leaseWaitMs" | "sleep"
  >,
  purpose: string,
) {
  return acquireLease({
    db: options.db,
    id: "gateway",
    purpose,
    breakLease: options.breakLease,
    waitMs: options.leaseWaitMs,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    onWait: (holder) =>
      options.out.emit({
        type: "progress",
        step: "gateway.lease",
        message: `Waiting for another deploy to finish: ${holder.holder} (${holder.purpose})...`,
      }),
    onHeartbeatProblem: (message) =>
      options.out.emit({
        type: "warning",
        code: "LEASE_HEARTBEAT",
        step: "gateway.lease",
        message,
      }),
  });
}

/**
 * The install record lags when an upgrade stopped between its upload and
 * its record: the Worker then serves a newer release than the record
 * names. Never replace that one with an older one either, when the live
 * gateway can say which it is (servingReleaseSha256).
 */
async function refuseDowngradeOfServing(
  options: ApplyGatewayOptions,
  install: InstallRecord,
): Promise<void> {
  const serving = await getWorkerDeployment(options.cf, GATEWAY_WORKER_NAME);
  if (!serving?.versionId || serving.versionId === install.liveVersionId) return;
  const sha256 = await servingReleaseSha256(
    options.readStatus ?? readPublicStatus,
    `https://${options.gatewayHost}`,
    serving.versionId,
  );
  if (
    !sha256 ||
    sha256 === install.releaseSha256 ||
    sha256 === options.release.manifest.sha256
  ) {
    return;
  }
  const live = await knownRelease(options.cf, options.resources.deployKvId, sha256);
  if (!live) return;
  try {
    if (
      compareReleaseOrder(
        releaseOrder(options.release.manifest),
        releaseOrder(live.manifest),
      ) < 0
    ) {
      throw downgradeRefused(options.release.manifest, live.manifest);
    }
  } finally {
    await live.cleanup();
  }
}

/** Whether a release is older than the one the install record names. */
export function olderThanInstalled(
  manifest: GatewayRelease["manifest"],
  install: InstallRecord,
): boolean {
  if (install.releaseSha256 === manifest.sha256) return false;
  return install.releaseOrder
    ? compareReleaseOrder(releaseOrder(manifest), install.releaseOrder) < 0
    : compareVersions(manifest.version, install.releaseVersion) < 0;
}

export function downgradeRefused(
  manifest: GatewayRelease["manifest"],
  running: { version: string; sha256: string },
): EveryAppError {
  return new EveryAppError(
    "DOWNGRADE_REFUSED",
    `The gateway runs release ${running.version} (${running.sha256.slice(0, 12)}), newer than ${manifest.version} (${manifest.sha256.slice(0, 12)}, built ${manifest.builtAt}). Upgrade everyapp, or pass --allow-downgrade.`,
  );
}

export async function applyGateway(
  options: ApplyGatewayOptions,
): Promise<ApplyGatewayResult> {
  const { cf, out, reason, release, db, resources } = options;
  const lease =
    options.dryRun || options.leaseHeld
      ? null
      : await acquireGatewayLease(options, `gateway.${reason}`);
  try {
    // Only now is the install record the last deploy's for sure: another
    // upgrade may have finished while this one waited for the lease.
    const install = options.dryRun ? null : await readInstall(db);
    if (
      install &&
      !options.allowDowngrade &&
      olderThanInstalled(release.manifest, install)
    ) {
      throw downgradeRefused(release.manifest, {
        version: install.releaseVersion,
        sha256: install.releaseSha256,
      });
    }
    if (reason !== "reconcile" && !options.dryRun) {
      // Before migrating: the registry's newest columns may not exist yet,
      // so no app is bound in this check.
      await withPatchedRelease(options, [], async () => undefined);
      if (install && !options.allowDowngrade) {
        await refuseDowngradeOfServing(options, install);
      }
      await assertReplaceable({
        cf,
        workerName: GATEWAY_WORKER_NAME,
        recordedVersionIds: [install?.liveVersionId],
        interactive: options.interactive,
        confirm: options.confirm,
        note: "If it runs a newer gateway release (an upgrade that stopped before recording itself), this replaces it with an older one.",
      });
      await migrate(options);
      out.emit({
        type: "step",
        step: "gateway.release_cache",
        status: "ok",
        message:
          (await cacheRelease(cf, resources.deployKvId, release)) === "stored"
            ? `Cached gateway release ${release.manifest.version} for later reconciles.`
            : `Gateway release ${release.manifest.version} is already cached.`,
      });
    }
    return await deployUntilSettled(options);
  } finally {
    await lease?.release();
  }
}

async function migrate({
  cf,
  out,
  db,
  resources,
  release,
  accountId,
}: ApplyGatewayOptions): Promise<void> {
  out.emit({
    type: "step",
    step: "gateway.migrations",
    status: "start",
    message: "Migrating the gateway's database...",
  });
  const result = await migrateRemoteD1({
    cf,
    db,
    databaseId: resources.d1Id,
    accountId,
    dir: path.join(release.dir, "drizzle"),
    journal: release.manifest.migrations,
    onProgress: (message) =>
      out.emit({ type: "progress", step: "gateway.migrations", message }),
  });
  out.emit({
    type: "step",
    step: "gateway.migrations",
    status: "ok",
    message:
      result.applied.length > 0
        ? `Applied ${result.applied.length} migration${result.applied.length === 1 ? "" : "s"}.`
        : "The gateway's database is up to date.",
    data: { bookmark: result.bookmark, applied: result.applied },
  });
}

async function deployUntilSettled(
  options: ApplyGatewayOptions,
): Promise<ApplyGatewayResult> {
  const { cf, out, release, db, gatewayHost } = options;
  const gatewayUrl = `https://${gatewayHost}`;
  let firstDeploy =
    (await getWorkerDeployment(cf, GATEWAY_WORKER_NAME)) === null;
  const wasFirstDeploy = firstDeploy;
  const workerExists = workerExistence(cf);
  let desired = await readDesiredState(db, workerExists);
  let versionId: string | null = null;
  let verified = false;

  for (let attempt = 1; ; attempt += 1) {
    for (const row of desired.skipped) {
      out.emit({
        type: "warning",
        code: "APP_NOT_BOUND",
        message: `Not binding app "${row.appId}": its Worker "${row.workerName}" isn't the one its registry row names.`,
      });
    }
    for (const row of desired.missing) {
      out.emit({
        type: "warning",
        code: "APP_WORKER_MISSING",
        message: `Not binding app "${row.appId}": its Worker "${row.workerName}" doesn't exist (deleted by hand, or never uploaded). Deploy the app again, or delete it.`,
      });
    }
    out.emit({
      type: "step",
      step: "gateway.deploy",
      status: "start",
      message: `${options.dryRun ? "Checking" : "Deploying"} gateway ${release.manifest.version} with ${desired.appWorkers.length} app${desired.appWorkers.length === 1 ? "" : "s"}...`,
      data: { appWorkers: desired.appWorkers },
    });
    const deployed = await deployOnce(options, desired, {
      secrets: {
        ...(firstDeploy
          ? firstDeploySecrets({ gatewayUrl, accountId: options.accountId })
          : {}),
        ...(attempt === 1 ? options.stagedSecrets : {}),
      },
    });
    if (options.dryRun) {
      return {
        versionId: null,
        firstDeploy,
        appWorkers: desired.appWorkers,
        verified: false,
        dryRunOutput: deployed.output,
      };
    }
    versionId = deployed.versionId;
    firstDeploy = false;
    out.emit({
      type: "step",
      step: "gateway.deploy",
      status: "ok",
      message: `Deployed gateway version ${versionId ?? "(unknown)"}.`,
      data: { versionId },
    });

    // The install row already names what went live (deployOnce records it
    // as soon as the upload is known), whatever happens next: an interrupt,
    // an edge slow to serve it. Before its first certificate, the gateway
    // can't answer over HTTPS; `cf workers deployments list` already
    // confirmed the version.
    verified = wasFirstDeploy
      ? false
      : await waitForStatus(options, gatewayUrl, desired);

    const latest = await readDesiredState(db, workerExists);
    if (sameBindings(latest, desired)) break;
    if (attempt >= MAX_DEPLOYS) {
      out.emit({
        type: "warning",
        code: "REGISTRY_CHANGING",
        message:
          "Apps kept registering during the deploy; run `everyapp gateway reconcile` once they settle.",
      });
      break;
    }
    out.emit({
      type: "progress",
      step: "gateway.deploy",
      message: "The registry changed during the deploy; deploying again with the new apps.",
    });
    desired = latest;
  }

  return {
    versionId,
    firstDeploy: wasFirstDeploy,
    appWorkers: desired.appWorkers,
    verified,
  };
}

function deployOnce(
  options: ApplyGatewayOptions,
  desired: DesiredState,
  { secrets }: { secrets: Record<string, string> },
): Promise<{ versionId: string | null; output: string }> {
  return withPatchedRelease(options, desired.appWorkers, (workdir) =>
    cfDeploy({
      cf: options.cf,
      cwd: workdir,
      workerName: GATEWAY_WORKER_NAME,
      accountId: options.accountId,
      message: `everyapp ${options.cliVersion} gateway ${options.release.manifest.version} (${options.reason})`,
      secrets,
      interactive: options.interactive,
      dryRun: options.dryRun,
      cliCf: true,
      onUploaded: (versionId) => record(options, desired, versionId),
    }),
  );
}

/** A private copy of the release, patched for this install and these apps. */
async function withPatchedRelease<T>(
  options: ApplyGatewayOptions,
  appWorkers: readonly string[],
  use: (workdir: string) => Promise<T>,
): Promise<T> {
  // cf runs in this copy, so it lives where no one else can plant a
  // cloudflare.config.ts above it (lib/cf/privateDir.ts).
  const workdir = await makeCfTempDir("gateway-deploy-");
  const forget = onInterrupt({
    sync: () => rmSync(workdir, { recursive: true, force: true }),
  });
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
      zoneId: options.zone.id,
      appWorkers,
    });
    return await use(workdir);
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
    forget();
  }
}

/** Poll the live gateway until it reports this release and these bindings. */
async function waitForStatus(
  options: ApplyGatewayOptions,
  gatewayUrl: string,
  desired: DesiredState,
): Promise<boolean> {
  const readStatus = options.readStatus ?? readPublicStatus;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS);
  for (;;) {
    try {
      const status = await readStatus(gatewayUrl);
      if (
        status.release?.sha256 === options.release.manifest.sha256 &&
        status.appBindingsDigest === desired.appBindingsDigest
      ) {
        options.out.emit({
          type: "step",
          step: "gateway.verify",
          status: "ok",
          message: "The new gateway version is serving.",
        });
        return true;
      }
    } catch {
      // Not reachable yet (or an older gateway without the endpoint).
    }
    if (Date.now() >= deadline) {
      options.out.emit({
        type: "warning",
        code: "GATEWAY_NOT_VERIFIED",
        step: "gateway.verify",
        message: `Cloudflare took the deploy, but ${gatewayUrl}/api/deploy/status doesn't report it yet. Check again with \`everyapp gateway status\`.`,
      });
      return false;
    }
    await sleep(VERIFY_INTERVAL_MS);
  }
}

async function record(
  options: ApplyGatewayOptions,
  desired: DesiredState,
  versionId: string | null,
): Promise<void> {
  const updatedAt = Date.now();
  await writeInstall(options.db, {
    accountId: options.accountId,
    zoneId: options.zone.id,
    zoneName: options.zone.name,
    gatewayHost: options.gatewayHost,
    appBaseDomain: options.gatewayHost,
    oauthKvId: options.resources.oauthKvId,
    deployKvId: options.resources.deployKvId,
    releaseVersion: options.release.manifest.version,
    releaseSha256: options.release.manifest.sha256,
    releaseOrder: releaseOrder(options.release.manifest),
    liveVersionId: versionId,
    liveDomains: [options.gatewayHost],
    liveAppWorkers: desired.appWorkers,
    updatedAt,
    updatedBy: `everyapp ${options.cliVersion} on ${os.hostname()}`,
  });
  await writeCachedInstall({
    gatewayHost: options.gatewayHost,
    accountId: options.accountId,
    zoneId: options.zone.id,
    zoneName: options.zone.name,
    databaseId: options.resources.d1Id,
    oauthKvId: options.resources.oauthKvId,
    deployKvId: options.resources.deployKvId,
    releaseVersion: options.release.manifest.version,
    releaseSha256: options.release.manifest.sha256,
    updatedAt: new Date(updatedAt).toISOString(),
  });
}

/** Thrown when an install row is required but this gateway has none. */
export function notDeployedByEveryapp(): EveryAppError {
  return new EveryAppError(
    "GATEWAY_NOT_INSTALLED",
    "This account's gateway wasn't deployed by this version of everyapp yet (it has no install record). Run `everyapp gateway deploy --domain <domain>` first.",
  );
}
