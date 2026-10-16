/**
 * `everyapp gateway reconcile`: make the live gateway bind exactly the apps
 * its registry says, by redeploying the gateway this checkout builds with a
 * fresh set of APP__ bindings. Run after an app is added or deleted
 * (`everyapp app deploy|delete` do it themselves), never for a code-only app
 * redeploy. A checkout newer than the live release upgrades the gateway on
 * the way, migrations first, as any gateway deploy does; one older than it
 * is refused (lib/gateway/apply.ts).
 *
 * Whether there is anything to do comes from the install row, never from
 * the gateway over HTTPS: the Worker serves the version the row names, and
 * the row's bound Workers and published hostnames are the registry's.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { cfD1Database } from "@/lib/cf/d1";
import type { Confirm } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
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
import { readInstall, type InstallRecord } from "./install";
import type { GatewayRelease } from "./release";

interface ReconcileGatewayOptions {
  cf: CfRunner;
  out: EventSink;
  accountId: string;
  /** The gateway's D1 database. */
  databaseId: string;
  /**
   * The release to deploy: the one this checkout builds (the build cache's,
   * or a new build: commands/gateway/shared.ts `openGatewayRelease`).
   * Opened only when there is something to deploy.
   */
  openRelease: () => Promise<GatewayRelease>;
  interactive: boolean;
  /** Publish new app hosts over the DNS records that answer them. */
  forceDns?: boolean;
  /** Asks a person before replacing a version everyapp didn't record (tests). */
  confirm?: Confirm;
  cliVersion: string;
  stagedSecrets?: Record<string, string>;
  dryRun?: boolean;
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

  if (!options.force && !options.stagedSecrets) {
    const desired = await readDesiredState(db, workerExistence(cf));
    if (await bindsAsRegistered(cf, install, desired)) {
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
    const lease = options.dryRun
      ? null
      : await acquireGatewayLease(
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
      const current = (await readInstall(db)) ?? install;
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
        ...(lease ? { heldLease: lease } : {}),
        dryRun: options.dryRun,
        sleep: options.sleep,
      });
      return { ...result, changed: true };
    } finally {
      await lease?.release();
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
async function bindsAsRegistered(
  cf: CfRunner,
  install: InstallRecord,
  desired: DesiredState,
): Promise<boolean> {
  const sameWorkers =
    [...install.liveAppWorkers].sort().join("\n") ===
    desired.appWorkers.join("\n");
  if (!sameWorkers || !publishesHosts(install, desired.appHosts)) return false;
  const serving = await getWorkerDeployment(cf, GATEWAY_WORKER_NAME);
  return Boolean(serving?.versionId) && serving?.versionId === install.liveVersionId;
}

/** Whether the install already publishes exactly these app hosts. */
function publishesHosts(install: InstallRecord, appHosts: readonly string[]): boolean {
  const live = install.liveDomains.filter((host) => host !== install.gatewayHost);
  const wanted = appHosts.filter((host) =>
    isOneLabelBelow(host, install.appBaseDomain),
  );
  return [...live].sort().join("\n") === [...wanted].sort().join("\n");
}
