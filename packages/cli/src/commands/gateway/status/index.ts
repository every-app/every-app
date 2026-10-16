import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import type { LocalContext } from "@/context";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { certificateStatus } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import {
  readDesiredState,
  workerExistence,
  type DesiredState,
} from "@/lib/gateway/desiredState";
import { checkoutRoot } from "@/lib/checkout";
import { olderThanInstalled } from "@/lib/gateway/apply";
import {
  checkoutSource,
  type CheckoutSource,
} from "@/lib/gateway/checkoutRelease";
import type { FoundGateway } from "@/lib/gateway/discover";
import type { InstallRecord } from "@/lib/gateway/install";
import { readLiveLeases, type LeaseHolder } from "@/lib/gateway/lease";
import { gatewayDomains } from "@/lib/gateway/patchBuildOutput";
import { listApps } from "@/lib/gateway/registry";
import { readOwner, type GatewayOwner } from "@/lib/gateway/setup-link";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { eventSink, existingGateway, runReported } from "../shared";

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
 * Worker serves the version that row names, whether it was built from this
 * checkout's Gateway sources (`upToDate`, by tree hash, nothing built), its
 * owner, the apps its registry lists and whether the live version binds
 * them, each published hostname's certificate (Cloudflare's certificate
 * packs), any deploy in progress, and `fixes`: what to run when something
 * is off.
 */
export async function status(
  this: LocalContext,
  flags: StatusFlags,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const gateway = await existingGateway({
        json: flags.json,
        out,
        accountId: flags["account-id"],
      });
      await reportStatus({
        gateway,
        out,
        checkout: () => checkoutSource(checkoutRoot()),
      });
    },
    { verbose: flags.verbose },
  );
}

/** The status of the Gateway discovery found, as the command's `done` event. */
export async function reportStatus({
  gateway,
  out,
  checkout,
}: {
  gateway: FoundGateway;
  out: EventSink;
  /** What this checkout's Gateway is, without building it. */
  checkout: () => Promise<CheckoutSource>;
}): Promise<void> {
  const { cf, account, db, install } = gateway;
  if (!install) {
    out.emit({
      type: "done",
      message: `${account.name ?? account.id} has the Gateway's database, but no install record: its install stopped before writing one. Finish it: ${CLI} setup --domain <hostname>`,
      data: {
        deployed: true,
        installed: false,
        accountId: account.id,
        fixes: [{ code: "GATEWAY_NOT_INSTALLED", message: "The Gateway has no install row.", run: "everyapp setup --domain <hostname>" }],
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
  const source = await checkoutAgainst(install, checkout);
  const fixes = fixesFor({
    install,
    desired,
    apps,
    owner,
    servingVersionId: serving?.versionId ?? null,
    inSync,
    waitingCertificates: waiting,
    leases,
    checkout: source,
  });

  const lines = [
    `Gateway:  ${gatewayUrl} (${account.name ?? account.id})`,
    `Release:  ${install.releaseVersion} (${install.releaseSha256.slice(0, 12)})${
      source.upToDate === true
        ? " · built from this checkout's sources"
        : source.upToDate === false
          ? source.behind
            ? " · newer than this checkout"
            : " · this checkout has changed since"
          : ""
    }${servingRecorded ? "" : `; the Worker serves ${serving?.versionId ?? "no version"}, not the recorded ${install.liveVersionId ?? "(none)"}`}`,
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
      upToDate: source.upToDate,
      checkout: source.checkout,
      tls: certificates === null ? null : !waiting.includes(install.gatewayHost),
      certificates,
      leases,
      fixes,
    },
  });
}

/** This checkout against the live release, by the install row. */
interface CheckoutState {
  /**
   * The live release was built from this checkout's Gateway sources (their
   * tree hash is the row's); null when either tree hash is unknown.
   */
  upToDate: boolean | null;
  /** The checkout's Gateway is older than the live one: `git pull`. */
  behind: boolean;
  checkout: { version: string; treeSha256: string | null } | null;
}

async function checkoutAgainst(
  install: InstallRecord,
  checkout: () => Promise<CheckoutSource>,
): Promise<CheckoutState> {
  // A checkout that can't be read doesn't stop the rest of the report.
  const source = await checkout().catch(() => null);
  if (!source) return { upToDate: null, behind: false, checkout: null };
  const upToDate =
    source.treeSha256 && install.sourceTreeSha256
      ? source.treeSha256 === install.sourceTreeSha256
      : null;
  return {
    upToDate,
    behind: upToDate === false && olderThanInstalled(source, install),
    checkout: { version: source.version, treeSha256: source.treeSha256 },
  };
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
  checkout,
}: {
  install: InstallRecord;
  desired: DesiredState;
  apps: AppState[];
  owner: GatewayOwner | null;
  servingVersionId: string | null;
  inSync: boolean;
  waitingCertificates: string[];
  leases: LeaseHolder[];
  checkout: CheckoutState;
}): Fix[] {
  const fixes: Fix[] = [];
  if (checkout.behind) {
    fixes.push({
      code: "CHECKOUT_BEHIND",
      message: `This checkout's Gateway (${checkout.checkout?.version}) is older than the live one (${install.releaseVersion}); deploys from here are refused until it catches up.`,
      run: "git pull",
    });
  } else if (checkout.upToDate === false && install.liveVersionId !== null) {
    fixes.push({
      code: "GATEWAY_OUTDATED",
      message: "This checkout's Gateway sources changed since the live release was built; the next deploy or delete of an app that rebinds the gateway upgrades it.",
      run: "everyapp setup",
    });
  }
  if (!owner) {
    fixes.push({
      code: "NO_OWNER",
      message: "The gateway has no owner yet; apps deploy without one, but nobody can sign in.",
      run: "everyapp setup",
    });
  }
  if (install.liveVersionId === null) {
    fixes.push({
      code: "GATEWAY_NOT_UPLOADED",
      message: "The Gateway's install stopped before its first upload finished.",
      run: "everyapp setup",
    });
  } else if (servingVersionId !== install.liveVersionId) {
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
