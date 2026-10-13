import type { LocalContext } from "@/context";
import { cfD1Database } from "@/lib/cf/d1";
import { checkSslReady } from "@/lib/gateway";
import { GatewayClient, type GatewayStatusResponse } from "@/lib/gateway/api";
import { olderThanInstalled } from "@/lib/gateway/apply";
import { readGatewayCredential } from "@/lib/gateway/credentials";
import {
  readDesiredState,
  workerExistence,
} from "@/lib/gateway/desiredState";
import { readInstall } from "@/lib/gateway/install";
import { readLease } from "@/lib/gateway/lease";
import { bundledReleaseManifest } from "@/lib/gateway/release";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import { gatewayHasOwner } from "@/lib/gateway/setup-link";
import {
  connectToAccount,
  eventSink,
  rememberedInstall,
  runReported,
} from "../shared";

interface StatusFlags {
  "account-id"?: string;
  json?: boolean;
  verbose?: boolean;
}

/**
 * How the gateway in this account stands: the release it runs against the
 * one this CLI bundles, whether it binds exactly the apps its registry
 * lists, its owner, its certificate, and any deploy in progress.
 */
export async function status(
  this: LocalContext,
  flags: StatusFlags,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      const cached = await rememberedInstall();
      const { cf, account } = await connectToAccount({
        json: flags.json,
        accountId: flags["account-id"],
        remembered: cached?.accountId,
      });
      const databaseId = await findGatewayDatabase(cf);
      if (!databaseId) {
        out.emit({
          type: "done",
          message: `No gateway is deployed in ${account.name ?? account.id}.`,
          data: { deployed: false },
        });
        return;
      }
      const db = cfD1Database(cf, databaseId);
      const [install, desired, lease, claimed] = await Promise.all([
        readInstall(db),
        readDesiredState(db, workerExistence(cf)),
        readLease(db, "gateway"),
        gatewayHasOwner(db),
      ]);
      const bundled = bundledReleaseManifest();
      if (!install) {
        out.emit({
          type: "done",
          message:
            "A gateway database exists, but this everyapp hasn't deployed the gateway yet: run `everyapp gateway deploy --domain <domain>`.",
          data: { deployed: true, installed: false },
        });
        return;
      }

      const gatewayUrl = `https://${install.gatewayHost}`;
      const authed = Boolean(await readGatewayCredential(gatewayUrl));
      const live: GatewayStatusResponse | null = await new GatewayClient({
        gatewayUrl,
      })
        .status({ auth: authed })
        .catch(() => null);
      const tls = await checkSslReady(gatewayUrl).catch(() => false);
      const inSync = live?.appBindingsDigest === desired.appBindingsDigest;
      const liveRelease = live?.release ?? null;
      const leaseHeld = lease && lease.expiresAt > Date.now() ? lease : null;

      const bundledNote =
        !bundled || bundled.sha256 === install.releaseSha256
          ? ""
          : olderThanInstalled(bundled, install)
            ? `; this everyapp bundles an older release (${bundled.version}, built ${bundled.builtAt}): upgrade everyapp`
            : `; this everyapp bundles ${bundled.version}: run \`everyapp gateway upgrade\``;
      const lines = [
        `Gateway:  ${gatewayUrl} (${account.name ?? account.id})`,
        `Release:  ${liveRelease ? `${liveRelease.version} (${liveRelease.sha256.slice(0, 12)})` : "unknown (the gateway didn't answer)"}${bundledNote}`,
        `Apps:     ${desired.appWorkers.length} to bind${live ? (inSync ? ", all bound" : "; the live gateway differs: run `everyapp gateway reconcile`") : ""}`,
        ...desired.skipped.map(
          (row) => `          not bound: ${row.appId} (${row.workerName} breaks the naming rule)`,
        ),
        ...desired.missing.map(
          (row) => `          not bound: ${row.appId} (its Worker ${row.workerName} doesn't exist)`,
        ),
        `Owner:    ${claimed ? "claimed" : "unclaimed: run `everyapp gateway claim-link`"}`,
        `TLS:      ${tls ? "ready" : "no certificate yet"}`,
        `Deploys:  ${leaseHeld ? `${leaseHeld.holder} is running ${leaseHeld.purpose} since ${new Date(leaseHeld.acquiredAt).toISOString()}` : "none running"}`,
      ];
      out.emit({
        type: "done",
        message: lines.join("\n"),
        data: {
          deployed: true,
          installed: true,
          gatewayUrl,
          accountId: account.id,
          release: liveRelease,
          bundledRelease: bundled
            ? { version: bundled.version, sha256: bundled.sha256 }
            : null,
          versionId: live?.versionId ?? null,
          desiredApps: desired.appWorkers,
          liveApps: live?.appBindings ?? null,
          inSync: live ? inSync : null,
          claimed,
          tls,
          lease: leaseHeld,
        },
      });
    },
    { verbose: flags.verbose },
  );
}
