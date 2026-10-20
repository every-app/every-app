/**
 * What the app commands that change the Gateway share (`deploy`,
 * `register`, `delete`): the Gateway release their rebind deploys, the
 * rebind itself, the registration from a manifest, and the wait for the
 * app to go live.
 */
import { appBindingName } from "@every-app/perimeter/manifest";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { readInstall, type InstallRecord } from "@/lib/gateway/install";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { register, type Deployer, type RegisterInput } from "@/lib/gateway/registry";
import type { CandidateRelease, GatewayRelease } from "@/lib/gateway/release";
import { gatewayReleaseSource } from "@/lib/gateway/source";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { version as cliVersion } from "../../package.json";
import { waitForLive, type LiveWaitSeams } from "./deploy/steps/waitForLive";

/**
 * The rebind's seams (tests): how long it waits for the gateway's lease,
 * how it sleeps, and the release it deploys (default: lib/gateway/source.ts,
 * the checkout's build or the latest release).
 */
export interface ReconcileSeams {
  sleep?: (ms: number) => Promise<void>;
  leaseWaitMs?: number;
  openRelease?: () => Promise<GatewayRelease>;
  /** What that release is, without building it from a checkout. */
  source?: () => Promise<CandidateRelease>;
}

/**
 * The Gateway an app command's rebind deploys, unless a test says: one
 * source for the downgrade guard and the rebind, so a release is fetched
 * once.
 */
export function gatewayFor(
  seams: ReconcileSeams | undefined,
  out: EventSink,
  verbose?: boolean,
): Required<Pick<ReconcileSeams, "openRelease" | "source">> {
  const gateway = gatewayReleaseSource({ out, verbose });
  return {
    openRelease: seams?.openRelease ?? gateway.open,
    source: seams?.source ?? gateway.describe,
  };
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

/** Register the app its manifest describes, one label below the Gateway's base. */
export function registerFromManifest(
  registry: D1Database,
  {
    manifest,
    install,
    deployer,
    accountName,
  }: {
    manifest: EveryAppCliManifest;
    install: Pick<InstallRecord, "appBaseDomain">;
    deployer: Deployer;
    /** Names the organization created when the gateway has none yet. */
    accountName: string | null;
  },
  options: Pick<RegisterInput, "scope" | "expectedWorkerName"> = {},
) {
  return register(registry, {
    appSlug: manifest.id,
    name: manifest.name ?? manifest.id,
    description: manifest.description ?? manifest.id,
    manifest,
    appBaseDomain: install.appBaseDomain,
    deployer,
    organizationName: accountName ?? "",
    ...options,
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
    // The Gateway this run deploys: an upgrade too, when it is newer.
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
 * With `wait`, wait for the app to go live, and once it is say `message`
 * on `app.live`. Returns whether it is live.
 */
export async function awaitLive({
  wait,
  db,
  appRowId,
  appId,
  hostname,
  out,
  seams,
  message,
}: {
  wait: boolean;
  db: D1Database;
  appRowId: string;
  appId: string;
  hostname: string;
  out: EventSink;
  seams?: LiveWaitSeams;
  message: string;
}): Promise<boolean> {
  if (!wait) return false;
  if ((await waitForLive({ db, appRowId, appId, hostname, out, ...seams })) !== "live") {
    return false;
  }
  out.emit({
    type: "step",
    step: "app.live",
    status: "ok",
    message,
    data: { hostname, url: `https://${hostname}` },
  });
  return true;
}

/** The `done` data of a deploy or register: where the app is, and whether it is live. */
export function liveDone(result: {
  liveUrl: string;
  workerName: string;
  versionId: string;
  live: boolean;
}) {
  return {
    url: result.liveUrl,
    workerName: result.workerName,
    versionId: result.versionId,
    live: result.live,
  };
}
