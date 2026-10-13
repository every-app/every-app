/**
 * `everyapp gateway reconcile`: make the live gateway bind exactly the apps
 * its registry says, by redeploying the release that is live with a fresh
 * set of APP__ bindings. Run after an app is added or deleted (`everyapp
 * app deploy|delete` do it themselves), never for a code-only app redeploy.
 *
 * The release is picked under the gateway lease, once no upgrade can be
 * running: the one the install record names, when the Worker serves the
 * version that record names too (each deploy records itself right after
 * the upload). Otherwise something deployed since, and the live gateway is
 * asked which release that is, from that version (servingReleaseSha256): a
 * newer one this account caches (an upgrade that stopped before recording
 * itself) is reconciled; anything else (an older release, one nobody can
 * resolve, no answer from that version) could put an older release back,
 * so a person decides. It comes from the deploy KV cache, checked against
 * its SHA-256; the release bundled with this CLI is used only when it is
 * that same release.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { cfD1Database } from "@/lib/cf/d1";
import { confirmAtTerminal, type Confirm } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { GatewayClient, type GatewayStatusResponse } from "./api";
import {
  acquireGatewayLease,
  applyGateway,
  notDeployedByEveryapp,
  type ApplyGatewayOptions,
  type ApplyGatewayResult,
} from "./apply";
import { readDesiredState, workerExistence } from "./desiredState";
import {
  assertUpgradedSinceAdopted,
  readInstall,
  type InstallRecord,
  type Routing,
} from "./install";
import type { BreakLease } from "./lease";
import {
  compareReleaseOrder,
  knownRelease,
  releaseOrder,
  servingReleaseSha256,
  type GatewayRelease,
} from "./release";
import { findGatewayDatabase } from "./resources";

interface ReconcileGatewayOptions {
  cf: CfRunner;
  out: EventSink;
  accountId: string;
  interactive: boolean;
  /** Publish new app hosts over DNS records and CAA blocks. */
  forceDns?: boolean;
  /**
   * Deploy with this routing instead of the install's (switching to
   * per-app domains); recorded only once cf has published every hostname
   * it brings (lib/gateway/apply.ts record()), so a switch cf stopped
   * part-way runs again.
   */
  routing?: Routing;
  lookupCaa?: ApplyGatewayOptions["lookupCaa"];
  /** Asks that person whether to redeploy a release it can't be sure is live (tests). */
  confirm?: Confirm;
  cliVersion: string;
  stagedSecrets?: Record<string, string>;
  breakLease?: BreakLease;
  dryRun?: boolean;
  /** Deploy even when the live bindings already match. */
  force?: boolean;
  /** The release this CLI bundles, used when it is the live one. */
  bundledTarball?: string | null;
  readStatus?: (gatewayUrl: string) => Promise<GatewayStatusResponse>;
  sleep?: ApplyGatewayOptions["sleep"];
  verifyTimeoutMs?: number;
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
  assertUpgradedSinceAdopted(install);
  const gatewayUrl = `https://${install.gatewayHost}`;

  const readStatus =
    options.readStatus ??
    ((url: string) => new GatewayClient({ gatewayUrl: url }).status());
  if (!options.force && !options.stagedSecrets && !options.routing) {
    const live = await readStatus(gatewayUrl).catch(() => null);
    const desired = await readDesiredState(db, workerExistence(cf));
    if (
      live?.appBindingsDigest === desired.appBindingsDigest &&
      publishesHosts(install, desired.appHosts)
    ) {
      out.emit({
        type: "step",
        step: "gateway.reconcile",
        status: "skip",
        message: `The gateway already binds ${desired.appWorkers.length === 1 ? "the 1 app" : `all ${desired.appWorkers.length} apps`} its registry lists.`,
      });
      return {
        versionId: live.versionId,
        firstDeploy: false,
        appWorkers: desired.appWorkers,
        domains: install.liveDomains,
        newHosts: [],
        verified: true,
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
          breakLease: options.breakLease,
          leaseWaitMs: options.leaseWaitMs,
          sleep: options.sleep,
        },
        "gateway.reconcile",
      );
  try {
    // Under the lease no upgrade runs, so the install record names the
    // release the last deploy put live, unless something else deployed since.
    const current = (await readInstall(db)) ?? install;
    const release = await releaseToReconcile({
      ...options,
      install: current,
      readStatus,
      gatewayUrl,
    });
    try {
      const result = await applyGateway({
        cf,
        out,
        reason: "reconcile",
        release,
        accountId: options.accountId,
        gatewayHost: current.gatewayHost,
        zone: { id: current.zoneId, name: current.zoneName },
        routing: options.routing ?? current.routing,
        appBaseDomain: current.appBaseDomain,
        forceDns: options.forceDns,
        lookupCaa: options.lookupCaa,
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
        leaseHeld: true,
        dryRun: options.dryRun,
        readStatus: options.readStatus,
        sleep: options.sleep,
        verifyTimeoutMs: options.verifyTimeoutMs,
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
 * Whether the install already publishes exactly these app hosts (always,
 * for an install whose apps reach it through the wildcard route).
 */
function publishesHosts(install: InstallRecord, appHosts: readonly string[]): boolean {
  if (install.routing === "wildcard-route") return true;
  const live = install.liveDomains.filter((host) => host !== install.gatewayHost);
  const wanted = appHosts.filter((host) =>
    isOneLabelBelow(host, install.appBaseDomain),
  );
  return [...live].sort().join("\n") === [...wanted].sort().join("\n");
}

/** The release to redeploy: see the top of this file. */
async function releaseToReconcile({
  cf,
  out,
  install,
  readStatus,
  gatewayUrl,
  bundledTarball,
  interactive,
  confirm = confirmAtTerminal,
}: ReconcileGatewayOptions & {
  install: InstallRecord;
  readStatus: (gatewayUrl: string) => Promise<GatewayStatusResponse>;
  gatewayUrl: string;
}): Promise<GatewayRelease> {
  const recorded = await knownRelease(
    cf,
    install.deployKvId,
    install.releaseSha256,
    bundledTarball,
  );
  if (!recorded) {
    throw new EveryAppError(
      "RELEASE_NOT_CACHED",
      `The live gateway release (${install.releaseVersion}, ${install.releaseSha256.slice(0, 12)}) isn't cached in this account, and this everyapp doesn't bundle it. Run \`everyapp gateway upgrade\`, or install everyapp@${install.releaseVersion}, then reconcile again.`,
    );
  }
  try {
    // The Worker serves the version the last deploy recorded: so it serves
    // the recorded release, whatever a lagging edge says.
    const serving = await getWorkerDeployment(cf, GATEWAY_WORKER_NAME);
    if (serving?.versionId && serving.versionId === install.liveVersionId) {
      return recorded;
    }

    const liveSha256 = await servingReleaseSha256(
      readStatus,
      gatewayUrl,
      serving?.versionId,
    );
    // The same release in another version: a redeploy that stopped before
    // recording itself.
    if (liveSha256 === install.releaseSha256) return recorded;
    const live = liveSha256
      ? await knownRelease(cf, install.deployKvId, liveSha256, bundledTarball)
      : null;
    if (
      live &&
      compareReleaseOrder(
        releaseOrder(live.manifest),
        releaseOrder(recorded.manifest),
      ) > 0
    ) {
      await recorded.cleanup();
      out.emit({
        type: "warning",
        code: "INSTALL_RECORD_STALE",
        message: `The gateway runs release ${live.manifest.version} (${live.manifest.sha256.slice(0, 12)}), newer than the ${install.releaseVersion} (${install.releaseSha256.slice(0, 12)}) its install record names: an upgrade stopped before recording itself. Reconciling the live one.`,
      });
      return live;
    }
    await live?.cleanup();

    const what = `The gateway serves version ${serving?.versionId ?? "(none)"}, not the ${install.liveVersionId ?? "(none)"} its install record names, and ${
      !liveSha256
        ? "the live gateway didn't say, from that version, which release it runs"
        : live
          ? `that is an older release (${live.manifest.version}, ${liveSha256.slice(0, 12)}; rolled back by hand?)`
          : `its release (${liveSha256.slice(0, 12)}) isn't one this account caches`
    }. Redeploying the recorded release ${install.releaseVersion} (${install.releaseSha256.slice(0, 12)}) could replace a newer one.`;
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
