import type { LocalContext } from "@/context";
import { cfD1Database } from "@/lib/cf/d1";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { checkSslReady } from "@/lib/gateway";
import { GatewayClient, type GatewayStatusResponse } from "@/lib/gateway/api";
import { readGatewayCredential } from "@/lib/gateway/credentials";
import {
  readDesiredState,
  workerExistence,
} from "@/lib/gateway/desiredState";
import {
  ADOPTED_RELEASE,
  migratedByDrizzleKit,
  readInstall,
} from "@/lib/gateway/install";
import { readLease } from "@/lib/gateway/lease";
import { gatewayDomains } from "@/lib/gateway/patchBuildOutput";
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
 * How the gateway in this account stands: the release it runs, whether it
 * binds and serves exactly the apps its registry lists, its owner, each
 * hostname's certificate, and any deploy in progress.
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
      const install = await readInstall(db);
      if (!install) {
        const wranglerEra = await migratedByDrizzleKit(db);
        out.emit({
          type: "done",
          message: wranglerEra
            ? "This account runs a gateway deployed before everyapp used cf: `everyapp gateway adopt --domain <its domain>` takes it over as it is."
            : "A gateway database exists, but this everyapp hasn't deployed the gateway yet: run `everyapp setup` (or `everyapp gateway deploy --domain <hostname>`).",
          data: { deployed: true, installed: false, adoptable: wranglerEra },
        });
        return;
      }
      if (install.releaseSha256 === ADOPTED_RELEASE) {
        out.emit({
          type: "done",
          message: `The gateway at https://${install.gatewayHost} is adopted (wildcard route, app hostnames kept) but not upgraded yet: run \`everyapp gateway upgrade\` from a terminal.`,
          data: { deployed: true, installed: true, adopted: true, gatewayHost: install.gatewayHost },
        });
        return;
      }
      const [desired, lease, claimed] = await Promise.all([
        readDesiredState(db, workerExistence(cf)),
        readLease(db, "gateway"),
        gatewayHasOwner(db),
      ]);

      const gatewayUrl = `https://${install.gatewayHost}`;
      const authed = Boolean(await readGatewayCredential(gatewayUrl));
      const live: GatewayStatusResponse | null = await new GatewayClient({
        gatewayUrl,
      })
        .status({ auth: authed })
        .catch(() => null);
      const perApp = install.routing === "custom-domains";
      const wanted = perApp
        ? gatewayDomains({
            gatewayHost: install.gatewayHost,
            routing: install.routing,
            appHosts: desired.appHosts.filter((host) =>
              isOneLabelBelow(host, install.appBaseDomain),
            ),
          })
        : [install.gatewayHost];
      const unpublished = wanted.filter((host) => !install.liveDomains.includes(host));
      const stale = install.liveDomains.filter((host) => !wanted.includes(host));
      const certificates = await Promise.all(
        install.liveDomains.map(async (host) => ({
          host,
          ready: await checkSslReady(`https://${host}/`).catch(() => false),
        })),
      );
      const waiting = certificates.filter((c) => !c.ready).map((c) => c.host);
      const tls = !waiting.includes(install.gatewayHost);
      const inSync =
        live?.appBindingsDigest === desired.appBindingsDigest &&
        unpublished.length === 0 &&
        stale.length === 0;
      const liveRelease = live?.release ?? null;
      const leaseHeld = lease && lease.expiresAt > Date.now() ? lease : null;

      const lines = [
        `Gateway:  ${gatewayUrl} (${account.name ?? account.id})`,
        `Release:  ${liveRelease ? `${liveRelease.version} (${liveRelease.sha256.slice(0, 12)})` : "unknown (the gateway didn't answer)"}`,
        `Routing:  ${perApp ? `each app its own Custom Domain under ${install.appBaseDomain}` : `wildcard route *.${install.gatewayHost} (switch: \`everyapp gateway use-per-app-domains\`)`}`,
        `Apps:     ${desired.appWorkers.length} to bind${live ? (inSync ? ", all bound" : "; the live gateway differs: run `everyapp gateway reconcile`") : ""}`,
        ...(unpublished.length
          ? [`          not served yet: ${unpublished.join(", ")}`]
          : []),
        ...(stale.length ? [`          still served: ${stale.join(", ")}`] : []),
        ...desired.skipped.map(
          (row) => `          not bound: ${row.appId} (${row.workerName} breaks the naming rule)`,
        ),
        ...desired.missing.map(
          (row) => `          not bound: ${row.appId} (its Worker ${row.workerName} doesn't exist)`,
        ),
        `Owner:    ${claimed ? "claimed" : "unclaimed: run `everyapp gateway claim-link`"}`,
        `TLS:      ${waiting.length === 0 ? `ready (${certificates.length} hostname${certificates.length === 1 ? "" : "s"})` : `no certificate yet for ${waiting.join(", ")}`}`,
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
          versionId: live?.versionId ?? null,
          desiredApps: desired.appWorkers,
          liveApps: live?.appBindings ?? null,
          routing: install.routing,
          appBaseDomain: install.appBaseDomain,
          domains: wanted,
          liveDomains: install.liveDomains,
          inSync: live ? inSync : null,
          claimed,
          tls,
          certificates,
          lease: leaseHeld,
        },
      });
    },
    { verbose: flags.verbose },
  );
}
