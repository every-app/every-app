import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import type { LocalContext } from "@/context";
import { emailRouteProblems, type EmailRouteProblem } from "@/lib/app/emailRoutes";
import { readResourcesOfKind } from "@/lib/app/ownership";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { certificateStatus } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import {
  readDesiredState,
  workerExistence,
  type DesiredState,
} from "@/lib/gateway/desiredState";
import { findCheckoutRoot } from "@/lib/checkout";
import { errorMessage } from "@/lib/errors";
import { olderThanInstalled } from "@/lib/gateway/apply";
import { checkoutSource } from "@/lib/gateway/checkoutRelease";
import type { FoundGateway } from "@/lib/gateway/discover";
import type { InstallRecord } from "@/lib/gateway/install";
import type { CandidateRelease } from "@/lib/gateway/release";
import { describeLeaseHolder, readLiveLeases, type LeaseHolder } from "@/lib/gateway/lease";
import { gatewayDomains } from "@/lib/gateway/patchBuildOutput";
import { listApps } from "@/lib/gateway/registry";
import { readOwner, type GatewayOwner } from "@/lib/gateway/setup-link";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { existingGateway } from "@/lib/gateway/connect";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { capitalize, plural } from "@/lib/output/text";

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
  /**
   * What its installation sends as and receives at (`everyapp email set`),
   * the addresses its deploys recorded routes for, and whether the manifest
   * it was deployed from declares inbound mail (without it no deploy routes
   * the stored addresses).
   */
  email: { senders: string[]; inbound: string[]; routed: string[]; declaresInbound: boolean };
}

/** Something off, and what to run about it (null: it settles by itself, wait). */
interface Fix {
  code: string;
  message: string;
  run: string | null;
}

/**
 * How the gateway in this account stands, all of it from its D1 and cf,
 * nothing over HTTPS: its deployment mode and the release its install row
 * records, whether the Worker serves the version that row names, whether
 * it was built from this checkout's Gateway sources (`upToDate`, by tree
 * hash, nothing built), its owner, the apps its registry lists and whether the live version binds
 * them, what each installation sends as and receives at (`everyapp email
 * set`), whether every stored address has its route and Email Routing
 * still delivers it, each published hostname's certificate (Cloudflare's certificate
 * packs), any deploy in progress, and `fixes`: what to run when something
 * is off.
 */
export async function status(
  this: LocalContext,
  flags: StatusFlags,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const gateway = await existingGateway({
      json: flags.json,
      out,
      accountId: flags["account-id"],
    });
    const root = findCheckoutRoot();
    await reportStatus({
      gateway,
      out,
      checkout: root ? () => checkoutSource(root) : null,
    });
  });
}

/** The status of the Gateway discovery found, as the command's `done` event. */
export async function reportStatus({
  gateway,
  out,
  checkout,
}: {
  gateway: FoundGateway;
  out: EventSink;
  /**
   * What this checkout's Gateway is, without building it; null when
   * everyapp doesn't run from a checkout.
   */
  checkout: (() => Promise<CandidateRelease>) | null;
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
        fixes: [{ code: "GATEWAY_NOT_INSTALLED", message: "The Gateway has no install row.", run: `${CLI} setup --domain <hostname>` }],
      },
    });
    return;
  }
  const [desired, registered, leases, owner, serving, emailRoutes] = await Promise.all([
    readDesiredState(db, workerExistence(cf)),
    listApps(db),
    readLiveLeases(db),
    readOwner(db),
    getWorkerDeployment(cf, GATEWAY_WORKER_NAME),
    readResourcesOfKind(db, "email-route"),
  ]);
  const certificates = await readCertificates(cf, install, out);
  const emailProblems = await readEmailProblems(cf, emailRoutes, out);

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
    email: {
      senders: app.email.senders,
      inbound: app.email.inbound,
      routed: emailRoutes
        .filter((route) => route.workerName === app.workerName)
        .map((route) => route.name),
      declaresInbound: app.declaresInbound,
    },
  }));
  const receiving = apps.filter(
    (app) => app.email.senders.length > 0 || app.email.inbound.length > 0 || app.email.routed.length > 0,
  );
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
    emailProblems,
  });

  const releaseNote =
    source.upToDate === true
      ? "matches this checkout"
      : source.upToDate === false
        ? source.behind
          ? "newer than this checkout"
          : "this checkout has changed since"
        : null;
  const facts = [
    {
      label: "Gateway",
      // The mode is a secret nothing reads back: the install row has it when
      // the first upload recorded it.
      value: `${chalk.cyan(gatewayUrl)}${install.deploymentMode ? chalk.dim(` · ${install.deploymentMode.replace("_", "-")}`) : ""}`,
    },
    { label: "Cloudflare", value: account.name ?? account.id },
    {
      label: "Owner",
      value: owner
        ? `${owner.email}${owner.organizationName ? chalk.dim(` · ${owner.organizationName}`) : ""}`
        : chalk.yellow("none yet"),
    },
    {
      label: "Release",
      value: `${install.releaseVersion}${releaseNote ? chalk.dim(` · ${releaseNote}`) : ""}${
        servingRecorded
          ? ""
          : chalk.yellow(` · the Worker serves ${serving?.versionId ?? "no version"}, not ${install.liveVersionId ?? "the one recorded"}`)
      }`,
    },
    {
      label: "TLS",
      value:
        certificates === null
          ? chalk.yellow("unknown (Cloudflare didn't list the zone's certificates)")
          : waiting.length === 0
            ? `ready on ${plural(certificates.length, "hostname")}`
            : chalk.yellow(`no certificate yet for ${waiting.join(", ")}`),
    },
    ...receiving.map((app, index) => ({
      label: index === 0 ? "Email" : "",
      value: `${app.id}: sends as ${app.email.senders.join(", ") || "the Gateway's sender only"}; receives ${
        app.email.inbound.length > 0 && !app.email.declaresInbound
          ? `nothing (${app.email.inbound.join(", ")} set, not declared)`
          : app.email.inbound.join(", ") || "nothing"
      }`,
    })),
    ...leases.map((lease, index) => ({
      label: index === 0 ? "Deploys" : "",
      value: describeLeaseHolder(lease),
    })),
  ];
  const display = [
    ...formatFacts(facts),
    "",
    ...(apps.length > 0
      ? formatTable(
          ["APP", "STATUS", "URL", "DEPLOYED BY"],
          apps.map((app) => [
            app.id,
            appStatus(app),
            chalk.cyan(`https://${app.hostname}`),
            app.deployedBy ?? "",
          ]),
        )
      : [chalk.dim(`No apps yet. Run: ${CLI} create my-app`)]),
    ...fixes.flatMap((fix, index) => [
      ...(index === 0 ? [""] : []),
      `${chalk.yellow("!")} ${fix.message}`,
      ...(fix.run ? [`  Run: ${chalk.bold(fix.run)}`] : []),
    ]),
  ].join("\n");
  out.emit({
    type: "done",
    message: stripVTControlCharacters(display),
    display,
    data: {
      deployed: true,
      installed: true,
      gatewayUrl,
      accountId: account.id,
      mode: install.deploymentMode,
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
  checkout: (() => Promise<CandidateRelease>) | null,
): Promise<CheckoutState> {
  // A checkout that can't be read doesn't stop the rest of the report.
  const source = checkout ? await checkout().catch(() => null) : null;
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
      message: `Couldn't list ${install.zoneName}'s certificates (${errorMessage(error)}).`,
    });
    return null;
  }
}

/**
 * The recorded mail routes that don't deliver to their app's Worker; null
 * (with a warning) when cf can't read them. The rest of the report goes on.
 */
async function readEmailProblems(
  cf: CfRunner,
  routes: Awaited<ReturnType<typeof readResourcesOfKind>>,
  out: EventSink,
): Promise<EmailRouteProblem[] | null> {
  if (routes.length === 0) return [];
  try {
    return await emailRouteProblems(cf, routes);
  } catch (error) {
    out.emit({
      type: "warning",
      code: "EMAIL_ROUTES_UNKNOWN",
      message: `Couldn't read the apps' Email Routing rules (${errorMessage(error)}).`,
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
  emailProblems,
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
  emailProblems: EmailRouteProblem[] | null;
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
      message: "This checkout's Gateway sources changed since the live release was built; setup upgrades it now, and so does the next deploy or delete of an app that has to rebind it.",
      run: `${CLI} setup`,
    });
  }
  if (!owner) {
    fixes.push({
      code: "NO_OWNER",
      message: "The gateway has no owner yet; apps deploy without one, but nobody can sign in.",
      run: `${CLI} setup`,
    });
  }
  if (install.liveVersionId === null) {
    fixes.push({
      code: "GATEWAY_NOT_UPLOADED",
      message: "The Gateway's install stopped before its first upload finished.",
      run: `${CLI} setup`,
    });
  } else if (servingVersionId !== install.liveVersionId) {
    fixes.push({
      code: "GATEWAY_CHANGED",
      message: `The gateway Worker serves ${servingVersionId ?? "no version"}, not the ${install.liveVersionId ?? "(none)"} its install row names: it was changed some other way (the dashboard, the API). setup redeploys it from this checkout; at a terminal, cf asks first.`,
      run: `${CLI} setup`,
    });
  } else if (!inSync) {
    fixes.push({
      code: "BINDINGS_DIFFER",
      message: "The live gateway doesn't bind or publish exactly the apps its registry lists.",
      run: `${CLI} setup`,
    });
  }
  for (const row of desired.missing) {
    fixes.push({
      code: "APP_WORKER_MISSING",
      message: `${row.appId}'s Worker ${row.workerName} doesn't exist.`,
      run: `${CLI} deploy (in ${row.appId}'s directory), or ${CLI} delete ${row.appId}`,
    });
  }
  for (const row of desired.skipped) {
    fixes.push({
      code: "APP_NOT_BOUND",
      message: `${row.appId}'s Worker ${row.workerName} isn't the one its naming rule gives it, so the gateway never binds it.`,
      run: `${CLI} delete ${row.appId}`,
    });
  }
  const missing = new Set(desired.missing.map((row) => row.workerName));
  for (const app of apps) {
    if (missing.has(app.workerName)) continue;
    if (app.status === "pending") {
      fixes.push({
        code: "APP_NOT_UPLOADED",
        message: `${app.id} is registered, but no deploy of it finished.`,
        run: `${CLI} deploy (in ${app.id}'s directory), or ${CLI} delete ${app.id}`,
      });
    } else if (app.status === "binding" && app.bound) {
      fixes.push({
        code: "APP_BINDING",
        message: `${app.id} goes live on its first visit to https://${app.hostname}.`,
        run: null,
      });
    }
  }
  for (const app of apps) {
    // The stored list is the intent, the ledger what exists.
    const notRouted = app.email.inbound.filter((address) => !app.email.routed.includes(address));
    const stale = app.email.routed.filter((address) => !app.email.inbound.includes(address));
    if (app.email.inbound.length > 0 && !app.email.declaresInbound) {
      // No deploy of that manifest routes these (it dropped the declaration
      // and kept the list, or the list came before the declaration did):
      // clear them, or deploy a manifest that declares them.
      fixes.push({
        code: "EMAIL_INBOUND_UNDECLARED",
        message: `${app.id}'s addresses (${app.email.inbound.join(", ")}) are stored, but the manifest it was deployed from doesn't declare email: { inbound: true }, so no mail is routed to it.`,
        run: `${CLI} email unset inbound (in ${app.id}'s directory), or ${CLI} deploy once everyapp.config.ts declares it`,
      });
    } else if (notRouted.length > 0 || stale.length > 0) {
      fixes.push({
        code: "EMAIL_ROUTE_PENDING",
        message: `Mail routes for ${app.id} don't match its addresses: ${[
          notRouted.length ? `not routed yet: ${notRouted.join(", ")}` : "",
          stale.length ? `still routed, no longer listed: ${stale.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ")}.`,
        run: `${CLI} deploy (in ${app.id}'s directory)`,
      });
    }
    const problems = (emailProblems ?? []).filter(
      (problem) => problem.workerName === app.workerName,
    );
    if (problems.length === 0) continue;
    fixes.push({
      code: "EMAIL_ROUTE_MISSING",
      message: `Mail for ${app.id} doesn't reach it: ${problems.map((problem) => `${problem.address} (${problem.problem})`).join(", ")}.`,
      run: `${CLI} deploy (in ${app.id}'s directory)`,
    });
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
      message: `${capitalize(describeLeaseHolder(lease))} is running.`,
      run: null,
    });
  }
  return fixes;
}

/** An app's STATUS cell: live, pending, or live but not bound. */
function appStatus(app: AppState): string {
  if (app.status === "active") {
    return app.bound ? `${chalk.green("✓")} live` : chalk.yellow("! not bound");
  }
  return chalk.dim(app.status);
}
