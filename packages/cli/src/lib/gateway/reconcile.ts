/**
 * Make the live gateway bind exactly the apps its registry says, by
 * redeploying the Gateway this run deploys (lib/gateway/source.ts: the
 * checkout's, or the latest release) with a fresh set of APP__
 * bindings. `everyapp deploy` and `delete` run it when the set of apps
 * changes, never for a code-only app redeploy; `setup` runs it to repair a
 * Gateway that is up to date but binds the wrong apps. A Gateway newer than
 * the live release upgrades it on the way, migrations first, as any
 * deploy of the gateway does; one older than it is refused (lib/gateway/apply.ts).
 *
 * Whether there is anything to do comes from the install row, never from
 * the gateway over HTTPS: the Worker serves the version the row names, and
 * the row's bound Workers and published hostnames are the registry's.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import type { Confirm } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { deleteWorkerSecret } from "@/lib/cf/secrets";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import type { EventSink } from "@/lib/output/events";
import {
  acquireGatewayLease,
  applyGateway,
  notDeployedByEveryapp,
  type ApplyGatewayOptions,
  type ApplyGatewayResult,
} from "./apply";
import { readDesiredState, workerExistence, type DesiredState } from "./desiredState";
import { readInstall, writeInstall, type InstallRecord } from "./install";
import { refuseNewerThanCli, type GatewayRelease } from "./release";

interface ReconcileGatewayOptions {
  cf: CfRunner;
  out: EventSink;
  accountId: string;
  /** The gateway's D1 database. */
  databaseId: string;
  /**
   * The release to deploy (lib/gateway/source.ts). Opened only when there
   * is something to deploy.
   */
  openRelease: () => Promise<GatewayRelease>;
  interactive: boolean;
  /** Publish new app hosts over the DNS records that answer them. */
  forceDns?: boolean;
  /** Asks a person before replacing a version everyapp didn't record (tests). */
  confirm?: Confirm;
  cliVersion: string;
  /** Settings to send with the upload (tests; `secret set` changes the live Worker instead). */
  stagedSecrets?: Record<string, string>;
  /** Settings to drop first, under the lease (tests; `secret unset` changes the live Worker instead). */
  unsetSecrets?: readonly string[];
  /** Deploy even when the live bindings already match. */
  force?: boolean;
  sleep?: ApplyGatewayOptions["sleep"];
  leaseWaitMs?: number;
}

interface ReconcileResult extends ApplyGatewayResult {
  /** False when the live gateway already bound exactly these apps. */
  changed: boolean;
}

export async function reconcileGateway(
  options: ReconcileGatewayOptions,
): Promise<ReconcileResult> {
  const { cf, out, databaseId } = options;
  const db = cfD1Database(cf, databaseId);
  const install = await readInstall(db);
  if (!install) throw notDeployedByEveryapp();

  if (!options.force && !options.stagedSecrets && !options.unsetSecrets) {
    const { inSync, desired } = await registryDrift(cf, db, install);
    if (inSync) {
      out.emit({
        type: "step",
        step: "gateway.reconcile",
        status: "skip",
        message: `The gateway already binds ${desired.appWorkers.length === 1 ? "the 1 app" : `all ${desired.appWorkers.length} apps`} its registry lists.`,
      });
      return {
        versionId: install.liveVersionId,
        firstDeploy: false,
        appWorkers: desired.appWorkers,
        domains: install.liveDomains,
        newHosts: [],
        changed: false,
      };
    }
  }

  // Before the lease: a build that misses the cache takes a minute or two.
  const release = await options.openRelease();
  try {
    refuseNewerThanCli(release.manifest, options.cliVersion);
    const lease = await acquireGatewayLease(
      {
        db,
        out,
        leaseWaitMs: options.leaseWaitMs,
        sleep: options.sleep,
      },
      "gateway.reconcile",
    );
    try {
      // Under the lease, the install row is the last deploy's for sure.
      let current = (await readInstall(db)) ?? install;
      if (options.unsetSecrets?.length) {
        await lease.check();
        current = await dropSecrets(cf, db, current, options.unsetSecrets);
      }
      const result = await applyGateway({
        cf,
        out,
        reason: "reconcile",
        release,
        accountId: options.accountId,
        gatewayHost: current.gatewayHost,
        zone: { id: current.zoneId, name: current.zoneName },
        appBaseDomain: current.appBaseDomain,
        forceDns: options.forceDns,
        resources: {
          d1Id: databaseId,
          oauthKvId: current.oauthKvId,
          created: [],
        },
        db,
        interactive: options.interactive,
        confirm: options.confirm,
        cliVersion: options.cliVersion,
        stagedSecrets: options.stagedSecrets,
        heldLease: lease,
        sleep: options.sleep,
      });
      return { ...result, changed: true };
    } finally {
      await lease.release();
    }
  } finally {
    await release.cleanup();
  }
}

/**
 * Whether the live gateway binds and publishes exactly what the registry
 * says, by the install row: the Worker serves the version the row names,
 * which bound the row's Workers and published its hostnames.
 */
export async function registryDrift(
  cf: CfRunner,
  db: D1Database,
  install: InstallRecord,
): Promise<{ inSync: boolean; desired: DesiredState }> {
  const desired = await readDesiredState(db, workerExistence(cf));
  const sameWorkers =
    [...install.liveAppWorkers].sort().join("\n") ===
    desired.appWorkers.join("\n");
  if (!sameWorkers || !publishesHosts(install, desired.appHosts)) {
    return { inSync: false, desired };
  }
  const serving = await getWorkerDeployment(cf, GATEWAY_WORKER_NAME);
  return {
    inSync: Boolean(serving?.versionId) && serving?.versionId === install.liveVersionId,
    desired,
  };
}

/** Whether the install already publishes exactly these app hosts. */
function publishesHosts(install: InstallRecord, appHosts: readonly string[]): boolean {
  const live = install.liveDomains.filter((host) => host !== install.gatewayHost);
  const wanted = appHosts.filter((host) =>
    isOneLabelBelow(host, install.appBaseDomain),
  );
  return [...live].sort().join("\n") === [...wanted].sort().join("\n");
}

/**
 * Delete settings from the gateway Worker. Cloudflare makes a new version
 * of the live one without them; the install row records it as the live
 * version, so the redeploy that follows replaces it as everyapp's own.
 */
async function dropSecrets(
  cf: CfRunner,
  db: D1Database,
  install: InstallRecord,
  names: readonly string[],
): Promise<InstallRecord> {
  for (const name of names) await deleteWorkerSecret(cf, GATEWAY_WORKER_NAME, name);
  const serving = await getWorkerDeployment(cf, GATEWAY_WORKER_NAME);
  if (!serving?.versionId || serving.versionId === install.liveVersionId) return install;
  const updated = { ...install, liveVersionId: serving.versionId, updatedAt: Date.now() };
  await writeInstall(db, updated);
  return updated;
}
