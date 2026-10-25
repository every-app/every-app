import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { storedSecretNames } from "@every-app/perimeter/registry";
import type { AppSetup } from "@every-app/sdk/internal";
import { readAccessState } from "@/lib/access/settings";
import { emailRouteProblems } from "@/lib/app/emailRoutes";
import { readResourcesOfKind } from "@/lib/app/ownership";
import {
  appSetupFrom,
  declaresSettings,
  listAppSecretNames,
  listGatewaySecretNames,
} from "@/lib/app/settings";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { certificateStatus } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { readDesiredState, workerExistence } from "@/lib/gateway/desiredState";
import { findCheckoutRoot } from "@/lib/checkout";
import { errorMessage } from "@/lib/errors";
import { olderThanInstalled } from "@/lib/gateway/apply";
import { checkoutSource } from "@/lib/gateway/checkoutRelease";
import type { FoundGateway } from "@/lib/gateway/discover";
import type { InstallRecord } from "@/lib/gateway/install";
import type { CandidateRelease } from "@/lib/gateway/release";
import { readLiveLeases } from "@/lib/gateway/lease";
import { gatewayDomains } from "@/lib/gateway/patchBuildOutput";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { listApps, writeAppSecretNames, type RegisteredAppInfo } from "@/lib/gateway/registry";
import { readOwner } from "@/lib/gateway/setup-link";
import type { EventSink } from "@/lib/output/events";
import { existingGateway } from "@/lib/gateway/connect";
import { runCommand } from "@/lib/output/run";
import { plural } from "@/lib/output/text";
import {
  needsFixing,
  notInstalled,
  problemsFor,
  type AppState,
  type CheckoutState,
  type Problem,
  type Unread,
} from "./problems";
import { renderNotInstalled, renderStatus } from "./render";

interface StatusFlags {
  "account-id"?: string;
  json?: boolean;
  verbose?: boolean;
}

/**
 * How the gateway in this account stands, all of it from its D1 and cf,
 * nothing over HTTPS: its deployment mode and the release its install row
 * records, whether the Worker serves the version that row names, whether
 * it was built from this checkout's Gateway sources (`upToDate`, by tree
 * hash, nothing built), its owner, the apps its registry lists and whether the live version binds
 * them, what each installation sends as and receives at (`everyapp email
 * set`), whether every stored address has its route and Email Routing
 * still delivers it, what each app's manifest needs set and whether it is
 * (the Gateway Worker's secret names and each app Worker's, which it
 * records on the app's row for the gateway), what each app's deployed
 * manifest opens without a sign-in (its public routes, and `/mcp` on its
 * host where the manifest asks for it), each published hostname's
 * certificate (Cloudflare's certificate packs), whether Cloudflare Access
 * is in front (the Gateway Worker's settings, by name), any deploy in
 * progress, and `fixes`: what is off, and what to run about it.
 */
export async function status(flags: StatusFlags,
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

/**
 * A problem as `data.fixes` carries it for a script: its severity, so an
 * informational item isn't taken for something to fix, and the note after
 * `run`, so what it does isn't lost.
 */
function fixData(problem: Problem) {
  return {
    code: problem.code,
    severity: problem.severity,
    message: [problem.headline, ...problem.detail].join("\n"),
    run: problem.run?.text ?? null,
    ...(problem.runNote ? { note: problem.runNote } : {}),
    ...(problem.fix ? { fix: problem.fix.text } : {}),
  };
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
  const accountName = account.name ?? account.id;
  if (!install) {
    const problem = notInstalled();
    out.emit({
      type: "done",
      message: `${accountName} has the Gateway's database, but its install didn't finish`,
      display: renderNotInstalled(accountName, problem),
      data: {
        deployed: true,
        installed: false,
        accountId: account.id,
        fixes: [fixData(problem)],
      },
    });
    return;
  }
  // Access is the Gateway Worker's: a hosted Gateway ignores its settings,
  // and before the first upload there is no Worker to read.
  const accessApplies = install.deploymentMode !== "hosted" && install.liveVersionId !== null;
  const [desired, registered, leases, owner, serving, emailRoutes, access] = await Promise.all([
    readDesiredState(db, workerExistence(cf)),
    // A provider app has no Worker or host to report on; `provider list` is its command.
    listApps(db).then((apps) => apps.filter((app) => app.tier !== PROVIDER_APP_TIER)),
    readLiveLeases(db),
    readOwner(db),
    getWorkerDeployment(cf, GATEWAY_WORKER_NAME),
    readResourcesOfKind(db, "email-route"),
    accessApplies ? readOrUnread(() => readAccessState(cf, db)) : null,
  ]);
  const accessState = access && "value" in access ? access.value : null;
  const accessUnread = access && "error" in access ? access : null;
  const missingWorkers = new Set(desired.missing.map((row) => row.workerName));
  const [certificates, emailProblems, settings] = await Promise.all([
    readOrUnread(() => certificateStatus(cf, install.zoneId, install.liveDomains)),
    readOrUnread(async () =>
      emailRoutes.length === 0 ? [] : emailRouteProblems(cf, emailRoutes),
    ),
    readSettings(cf, db, registered, missingWorkers),
  ]);

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
    publicRoutes: app.publicRoutes,
    mcp: app.mcp,
    setup: settings.setups.get(app.appSlug) ?? null,
  }));
  const readCertificates = "error" in certificates ? null : certificates.value;
  const waiting = (readCertificates ?? []).filter((c) => !c.ready).map((c) => c.host);
  const source = await checkoutAgainst(install, checkout);
  const problems = problemsFor({
    install,
    desired,
    apps,
    unboundApps: apps.filter((app) => unbound.includes(app.workerName)).map((app) => app.id),
    owner,
    servingVersionId: serving?.versionId ?? null,
    inSync,
    waitingCertificates: waiting,
    certificates: "error" in certificates ? certificates : null,
    access: accessUnread,
    leases,
    checkout: source,
    emailProblems: "error" in emailProblems ? emailProblems : emailProblems.value,
    settings: settings.unread,
  });
  const display = renderStatus({
    install,
    accountName,
    owner,
    servingRecorded,
    checkout: source,
    certificates: readCertificates,
    waitingCertificates: waiting,
    access: accessUnread ?? accessState,
    leases,
    apps,
    missingWorkers,
    skippedWorkers: new Set(desired.skipped.map((row) => row.workerName)),
    emailProblems: "error" in emailProblems ? [] : emailProblems.value,
    problems,
  });
  out.emit({
    type: "done",
    message: summary(gatewayUrl, apps, problems),
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
      tls: readCertificates === null ? null : !waiting.includes(install.gatewayHost),
      certificates: readCertificates,
      // Null when it doesn't apply (a hosted Gateway, no Worker yet) or cf couldn't say.
      access: accessState,
      leases,
      fixes: problems.map(fixData),
    },
  });
}

/** The report in one line, for a script: "Gateway https://…: 1 app live, nothing to fix". */
function summary(gatewayUrl: string, apps: AppState[], problems: Problem[]): string {
  const live = apps.filter((app) => app.status === "active" && app.bound).length;
  const toFix = problems.filter(needsFixing).length;
  return `Gateway ${gatewayUrl}: ${plural(live, "app")} live, ${toFix === 0 ? "nothing to fix" : `${plural(toFix, "problem")} to fix`}`;
}

/**
 * Each deployed app's settings against what is set: the Gateway Worker's
 * secret names, and the app Worker's, recorded on the app's row when they
 * differ from what it holds, so an out-of-band change or a row from before
 * the column heals here. A `pending` app or one whose Worker no longer
 * exists has nothing to evaluate yet (its own problem says so), and a
 * dispatch-tier app's settings the platform doesn't gate, so it is left
 * out too (`setup: null`). A list that fails leaves its names unknown
 * (`set: null`, which never blocks) and is said once, as SETTINGS_UNKNOWN.
 */
async function readSettings(
  cf: FoundGateway["cf"],
  db: FoundGateway["db"],
  apps: RegisteredAppInfo[],
  missingWorkers: Set<string>,
): Promise<{ setups: Map<string, AppSetup>; unread: Unread | null }> {
  const setups = new Map<string, AppSetup>();
  const declaring = apps.filter(
    (app) =>
      app.manifest &&
      declaresSettings(app.manifest) &&
      app.tier !== "dispatch" &&
      app.status !== "pending" &&
      !missingWorkers.has(app.workerName),
  );
  if (declaring.length === 0) return { setups, unread: null };
  let unread: Unread | null = null;
  const gateway = await readOrUnread(() => listGatewaySecretNames(cf));
  if ("error" in gateway) unread = gateway;
  for (const app of declaring) {
    const own = await readOrUnread(() => listAppSecretNames(cf, app.workerName));
    if ("error" in own) unread ??= own;
    const secretNames = "error" in own ? null : own.value;
    if (
      secretNames &&
      (app.secretNames === null ||
        storedSecretNames(secretNames) !== storedSecretNames(app.secretNames))
    ) {
      await writeAppSecretNames(db, app.id, secretNames);
    }
    const { setup } = appSetupFrom({
      manifest: app.manifest!,
      appId: app.appSlug,
      gatewayNames: "error" in gateway ? null : gateway.value,
      secretNames,
    });
    setups.set(app.appSlug, setup);
  }
  return { setups, unread };
}

/** What cf says, or why it couldn't say: the rest of the report goes on. */
async function readOrUnread<T>(read: () => Promise<T>): Promise<{ value: T } | Unread> {
  try {
    return { value: await read() };
  } catch (error) {
    return { error: errorMessage(error) };
  }
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
