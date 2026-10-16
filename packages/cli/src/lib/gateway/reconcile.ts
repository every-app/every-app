/**
 * `everyapp gateway reconcile`: make the live gateway bind exactly the apps
 * its registry says, by redeploying the release that is live with a fresh
 * set of APP__ bindings. Run after an app is added or deleted (`everyapp
 * app deploy|delete` do it themselves), never for a code-only app redeploy.
 *
 * Whether there is anything to do comes from the install row, never from
 * the gateway over HTTPS: the Worker serves the version the row names, and
 * the row's bound Workers and published hostnames are the registry's.
 *
 * The release is picked under the gateway lease, once no upgrade can be
 * running: the one the install record names, when the Worker serves the
 * version that record names too (each deploy records itself right after
 * the upload). Otherwise something deployed since (an upgrade that stopped
 * before recording itself, a rollback in the dashboard), and redeploying
 * the recorded release could put an older one back, so a person decides.
 * It comes from the deploy KV cache, checked against its SHA-256:
 * reconciling never deploys the gateway from this checkout.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { cfD1Database } from "@/lib/cf/d1";
import { confirmAtTerminal, type Confirm } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
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
import { fetchCachedRelease, type GatewayRelease } from "./release";
import { findGatewayDatabase } from "./resources";

interface ReconcileGatewayOptions {
  cf: CfRunner;
  out: EventSink;
  accountId: string;
  interactive: boolean;
  /** Publish new app hosts over the DNS records that answer them. */
  forceDns?: boolean;
  /** Asks that person whether to redeploy a release it can't be sure is live (tests). */
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
  const { cf, out } = options;
  const databaseId = await findGatewayDatabase(cf);
  if (!databaseId) {
    throw new EveryAppError(
      "GATEWAY_NOT_DEPLOYED",
      "No gateway is deployed in this Cloudflare account. Run `everyapp gateway deploy --domain <domain>` first.",
    );
  }
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
    // Under the lease no upgrade runs, so the install record names the
    // release the last deploy put live, unless something else deployed since.
    const current = (await readInstall(db)) ?? install;
    const release = await releaseToReconcile({ ...options, install: current });
    try {
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
          deployKvId: current.deployKvId,
          created: [],
        },
        db,
        interactive: options.interactive,
        cliVersion: options.cliVersion,
        stagedSecrets: options.stagedSecrets,
        ...(lease ? { heldLease: lease } : {}),
        dryRun: options.dryRun,
        sleep: options.sleep,
      });
      return { ...result, changed: true };
    } finally {
      await release.cleanup();
    }
  } finally {
    await lease?.release();
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

/** The release to redeploy: see the top of this file. */
async function releaseToReconcile({
  cf,
  install,
  interactive,
  confirm = confirmAtTerminal,
}: ReconcileGatewayOptions & {
  install: InstallRecord;
}): Promise<GatewayRelease> {
  const recorded = await fetchCachedRelease(
    cf,
    install.deployKvId,
    install.releaseSha256,
  );
  if (!recorded) {
    throw new EveryAppError(
      "RELEASE_NOT_CACHED",
      `The live gateway release (${install.releaseVersion}, ${install.releaseSha256.slice(0, 12)}) isn't cached in this account. Run \`everyapp gateway upgrade\` to deploy the gateway from this checkout, then reconcile again.`,
    );
  }
  try {
    // The Worker serves the version the last deploy recorded: so it serves
    // the recorded release.
    const serving = await getWorkerDeployment(cf, GATEWAY_WORKER_NAME);
    if (serving?.versionId && serving.versionId === install.liveVersionId) {
      return recorded;
    }
    const what = `The gateway serves version ${serving?.versionId ?? "(none)"}, not the ${install.liveVersionId ?? "(none)"} its install record names: it was deployed some other way since, or an upgrade stopped before recording itself. Redeploying the recorded release ${install.releaseVersion} (${install.releaseSha256.slice(0, 12)}) could replace a newer one.`;
    if (!interactive) {
      throw new ActionRequiredError(
        "rerun_interactive",
        `${what} The gateway is unchanged: check \`everyapp gateway status\`, then run this command in a terminal to decide.`,
      );
    }
    if (!(await confirm(`${what} Redeploy it anyway?`))) {
      throw new EveryAppError("DEPLOY_CANCELLED", "The gateway is unchanged.");
    }
    return recorded;
  } catch (error) {
    await recorded.cleanup();
    throw error;
  }
}
