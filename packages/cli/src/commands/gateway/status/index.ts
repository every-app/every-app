import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import type { LocalContext } from "@/context";
import { cfD1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { certificateStatus } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import {
  readDesiredState,
  workerExistence,
  type DesiredState,
} from "@/lib/gateway/desiredState";
import { readInstall, type InstallRecord } from "@/lib/gateway/install";
import { readLiveLeases, type LeaseHolder } from "@/lib/gateway/lease";
import { gatewayDomains } from "@/lib/gateway/patchBuildOutput";
import { listApps } from "@/lib/gateway/registry";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import { readOwner, type GatewayOwner } from "@/lib/gateway/setup-link";
import type { EventSink } from "@/lib/output/events";
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

/** An app as status shows it: the registry's row, and whether the live gateway binds it. */
interface AppState {
  id: string;
  hostname: string;
  workerName: string;
  status: string;
  /** The version the install row names binds its Worker. */
  bound: boolean;
  /** Who deployed it last: an email, or `api-token:<account id>`. */
  deployedBy: string | null;
}

/** Something off, and what to run about it (null: it settles by itself, wait). */
interface Fix {
  code: string;
  message: string;
  run: string | null;
}

/**
 * How the gateway in this account stands, all of it from its D1 and cf,
 * nothing over HTTPS: the release its install row records and whether the
 * Worker serves the version that row names, its owner, the apps its
 * registry lists and whether the live version binds them, each published
 * hostname's certificate (Cloudflare's certificate packs), any deploy in
 * progress, and `fixes`: what to run when something is off.
 */
export async function status(
  this: LocalContext,
  flags: StatusFlags,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const cached = await rememberedInstall();
      const { cf, account } = await connectToAccount({
        json: flags.json,
        accountId: flags["account-id"],
        remembered: cached?.accountId,
      });
      await reportStatus({ cf, account, out });
    },
    { verbose: flags.verbose },
  );
}

/** The status of the gateway in `cf`'s account, as the command's `done` event. */
export async function reportStatus({
  cf,
  account,
  out,
}: {
  cf: CfRunner;
  account: { id: string; name: string | null };
  out: EventSink;
}): Promise<void> {
  const databaseId = await findGatewayDatabase(cf);
  if (!databaseId) {
    out.emit({
      type: "done",
      message: `No gateway is deployed in ${account.name ?? account.id}.`,
      data: {
        deployed: false,
        fixes: [{ code: "NO_GATEWAY", message: "No gateway yet.", run: "everyapp setup --domain <hostname>" }],
      },
    });
    return;
  }
  const db = cfD1Database(cf, databaseId);
  const install = await readInstall(db);
  if (!install) {
    out.emit({
      type: "done",
      message:
        "A gateway database exists, but this everyapp hasn't deployed the gateway yet: run `everyapp setup` (or `everyapp gateway deploy --domain <hostname>`).",
      data: {
        deployed: true,
        installed: false,
        fixes: [{ code: "GATEWAY_NOT_INSTALLED", message: "The gateway has no install row.", run: "everyapp setup --domain <hostname>" }],
      },
    });
    return;
  }
  const [desired, registered, leases, owner, serving] = await Promise.all([
    readDesiredState(db, workerExistence(cf)),
    listApps(db),
    readLiveLeases(db),
    readOwner(db),
    getWorkerDeployment(cf, GATEWAY_WORKER_NAME),
  ]);
  const certificates = await readCertificates(cf, install, out);

  const gatewayUrl = `https://${install.gatewayHost}`;
  const wanted = gatewayDomains({
    gatewayHost: install.gatewayHost,
    appHosts: desired.appHosts.filter((host) =>
      isOneLabelBelow(host, install.appBaseDomain),
    ),
  });
  const unpublished = wanted.filter((host) => !install.liveDomains.includes(host));
  const stale = install.liveDomains.filter((host) => !wanted.includes(host));
  const unbound = desired.appWorkers.filter(
    (worker) => !install.liveAppWorkers.includes(worker),
  );
  const strayBindings = install.liveAppWorkers.filter(
    (worker) => !desired.appWorkers.includes(worker),
  );
  const servingRecorded =
    Boolean(serving?.versionId) && serving?.versionId === install.liveVersionId;
  const inSync =
    servingRecorded &&
    unbound.length === 0 &&
    strayBindings.length === 0 &&
    unpublished.length === 0 &&
    stale.length === 0;
  const apps: AppState[] = registered.map((app) => ({
    id: app.appSlug,
    hostname: app.hostname,
    workerName: app.workerName,
    status: app.status,
    bound: install.liveAppWorkers.includes(app.workerName),
    deployedBy: app.deployedBy,
  }));
  const waiting = (certificates ?? []).filter((c) => !c.ready).map((c) => c.host);
  const fixes = fixesFor({
    install,
    desired,
    apps,
    owner,
    servingVersionId: serving?.versionId ?? null,
    inSync,
    waitingCertificates: waiting,
    leases,
  });

  const lines = [
    `Gateway:  ${gatewayUrl} (${account.name ?? account.id})`,
    `Release:  ${install.releaseVersion} (${install.releaseSha256.slice(0, 12)})${servingRecorded ? "" : `; the Worker serves ${serving?.versionId ?? "no version"}, not the recorded ${install.liveVersionId ?? "(none)"}`}`,
    `Owner:    ${owner ? `${owner.email}${owner.organizationName ? ` (${owner.organizationName})` : ""}` : "none yet"}`,
    `Apps:     ${apps.length === 0 ? "none" : apps.map((app) => `${app.id} (${app.status}${app.bound || app.status === "pending" ? "" : ", not bound"})`).join(", ")}${apps.length > 0 && inSync ? " · all bound" : ""}`,
    `TLS:      ${
      certificates === null
        ? "unknown (Cloudflare didn't list the zone's certificates)"
        : waiting.length === 0
          ? `ready (${certificates.length} hostname${certificates.length === 1 ? "" : "s"})`
          : `no certificate yet for ${waiting.join(", ")}`
    }`,
    ...(leases.length
      ? leases.map(
          (lease, index) =>
            `${index === 0 ? "Deploys:  " : "          "}${describeDeploy(lease)}`,
        )
      : ["Deploys:  none running"]),
    ...fixes.map(
      (fix, index) =>
        `${index === 0 ? "To do:    " : "          "}${fix.message}${fix.run ? ` Run: ${fix.run}` : ""}`,
    ),
  ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    data: {
      deployed: true,
      installed: true,
      gatewayUrl,
      accountId: account.id,
      release: {
        version: install.releaseVersion,
        sha256: install.releaseSha256,
      },
      versionId: serving?.versionId ?? null,
      recordedVersionId: install.liveVersionId,
      owner,
      claimed: owner !== null,
      apps,
      desiredApps: desired.appWorkers,
      liveApps: install.liveAppWorkers,
      appBaseDomain: install.appBaseDomain,
      domains: wanted,
      liveDomains: install.liveDomains,
      inSync,
      tls: certificates === null ? null : !waiting.includes(install.gatewayHost),
      certificates,
      leases,
      fixes,
    },
  });
}

/** The published hostnames' certificates; null when cf can't list them. */
async function readCertificates(
  cf: CfRunner,
  install: InstallRecord,
  out: EventSink,
): Promise<Array<{ host: string; ready: boolean }> | null> {
  try {
    return await certificateStatus(cf, install.zoneId, install.liveDomains);
  } catch (error) {
    out.emit({
      type: "warning",
      code: "CERTIFICATES_UNKNOWN",
      message: `Couldn't list ${install.zoneName}'s certificates (${error instanceof Error ? error.message : String(error)}).`,
    });
    return null;
  }
}

/** What to run about what is off: from the registry, the install row and cf disagreeing. */
function fixesFor({
  install,
  desired,
  apps,
  owner,
  servingVersionId,
  inSync,
  waitingCertificates,
  leases,
}: {
  install: InstallRecord;
  desired: DesiredState;
  apps: AppState[];
  owner: GatewayOwner | null;
  servingVersionId: string | null;
  inSync: boolean;
  waitingCertificates: string[];
  leases: LeaseHolder[];
}): Fix[] {
  const fixes: Fix[] = [];
  if (!owner) {
    fixes.push({
      code: "NO_OWNER",
      message: "The gateway has no owner yet; apps deploy without one, but nobody can sign in.",
      run: "everyapp setup",
    });
  }
  if (servingVersionId !== install.liveVersionId) {
    fixes.push({
      code: "GATEWAY_CHANGED",
      message: `The gateway Worker serves ${servingVersionId ?? "no version"}, not the ${install.liveVersionId ?? "(none)"} its install row names: it was deployed some other way.`,
      run: "everyapp gateway reconcile --force",
    });
  } else if (!inSync) {
    fixes.push({
      code: "BINDINGS_DIFFER",
      message: "The live gateway doesn't bind or publish exactly the apps its registry lists.",
      run: "everyapp gateway reconcile",
    });
  }
  for (const row of desired.missing) {
    fixes.push({
      code: "APP_WORKER_MISSING",
      message: `${row.appId}'s Worker ${row.workerName} doesn't exist.`,
      run: `everyapp app deploy (in ${row.appId}'s directory), or everyapp app delete ${row.appId}`,
    });
  }
  for (const row of desired.skipped) {
    fixes.push({
      code: "APP_NOT_BOUND",
      message: `${row.appId}'s Worker ${row.workerName} isn't the one its naming rule gives it, so the gateway never binds it.`,
      run: `everyapp app delete ${row.appId}`,
    });
  }
  const missing = new Set(desired.missing.map((row) => row.workerName));
  for (const app of apps) {
    if (missing.has(app.workerName)) continue;
    if (app.status === "pending") {
      fixes.push({
        code: "APP_NOT_UPLOADED",
        message: `${app.id} is registered, but no deploy of it finished.`,
        run: `everyapp app deploy (in ${app.id}'s directory), or everyapp app delete ${app.id}`,
      });
    } else if (app.status === "binding" && app.bound) {
      fixes.push({
        code: "APP_BINDING",
        message: `${app.id} goes live on its first visit to https://${app.hostname}.`,
        run: null,
      });
    }
  }
  if (waitingCertificates.length > 0) {
    fixes.push({
      code: "CERT_PENDING",
      message: `No certificate yet for ${waitingCertificates.join(", ")}; it usually comes within minutes.`,
      run: null,
    });
  }
  for (const lease of leases) {
    fixes.push({
      code: "DEPLOY_RUNNING",
      message: `${lease.holder} is running ${lease.purpose}.`,
      run: null,
    });
  }
  return fixes;
}

/**
 * A running deploy: its lease, who holds it since when, and when it expires
 * unless that deploy renews it (it does every 30 seconds while it runs).
 */
function describeDeploy(lease: LeaseHolder): string {
  const at = (ms: number) => new Date(ms).toISOString();
  return `${lease.holder} is running ${lease.purpose} (lease ${lease.id}, since ${at(lease.acquiredAt)}, expires ${at(lease.expiresAt)} unless renewed)`;
}
