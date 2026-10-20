/**
 * `everyapp setup`: from an empty Cloudflare account to a working gateway
 * and its owner, in one command, and the way to upgrade or repair it
 * after. Apps are deployed afterwards (`everyapp deploy`), with the same
 * Cloudflare login, before or after the owner exists; `deploy` runs this
 * itself when the login finds no Gateway (installGateway).
 *
 * Every step looks at what is there first and acts only on what is
 * missing, so running setup again picks up where it stopped (a login to
 * approve, a domain to buy, a link nobody opened yet), and does nothing
 * once everything is there:
 *
 *    toolchain   Node and cf
 *    auth        cf logged in: `cf auth login` at a terminal, cf's device
 *                link and code under --json, or CLOUDFLARE_API_TOKEN
 *    account     the account whose Gateway the login finds
 *                (lib/gateway/discover.ts), or with none, where to install
 *                one: --account-id, CLOUDFLARE_ACCOUNT_ID, the only one, or
 *                a choice at the terminal
 *    release     what this run deploys (lib/gateway/source.ts), described
 *                before anything is asked: a --release that can't be had,
 *                or one that needs a newer everyapp, stops here
 *    plan        Workers Paid: a Free plan stops the run before anything is
 *                created; one that can't be confirmed is warned about
 *    domain      where the gateway lives: --domain, the install row's (also
 *                one an install wrote before it stopped), or an address
 *                typed at the terminal, under any of the account's active
 *                zones; a new one's DNS is checked before anything starts
 *    gateway     installed, or upgraded to that release; when it runs that
 *                release already (told by the install row's tree hash
 *                before anything is built, or the release's SHA-256), repaired:
 *                redeployed only if it doesn't bind and publish exactly the
 *                apps its registry lists, or serves a version the row
 *                doesn't name (lib/gateway/reconcile.ts), or --redeploy. A
 *                Gateway behind the live one is refused (git pull), unless
 *                --allow-downgrade
 *    owner       a one-time setup link, opened in the browser (never put
 *                into a CI log), and the wait for the claim, read from the
 *                link's own row in D1. In CI the run ends without one, with
 *                a warning: apps deploy without an owner
 *
 * What can be set up next (AI, email) is the command's `done.data.next`.
 * With --json, each step is an NDJSON event and what only a person can do
 * is `action_required`; a run that stops on one exits 2, and running the
 * same command again resumes it.
 */
import { version as packageVersion } from "../../../package.json";
import { roughly } from "@/lib/output/time";
import {
  deviceLoginAction,
  ensureCfAuth,
  resolveAccount,
} from "@/lib/cf/account";
import { PINNED_CF_VERSION } from "@/lib/cf/bin";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { workersPlansUrl } from "@/lib/cf/deploy";
import { WorkersPlan, workersPlan } from "@/lib/cf/plan";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { waitForCertificates } from "@/lib/domains/certWait";
import { normalizeHostname } from "@/lib/domains/hostnames";
import {
  probeHttps,
  type HttpsAnswer,
  type NoAnswerKind,
} from "@/lib/domains/https";
import { preflightDomains } from "@/lib/domains/preflight";
import { listZones, registerDomainUrl, zoneUrl } from "@/lib/domains/zones";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { candidate, isLiveRelease, refuseDowngrade } from "@/lib/gateway/apply";
import { GatewayChange } from "@/lib/gateway/change";
import { discoverGateway, type Discovery } from "@/lib/gateway/discover";
import type { InstallRecord } from "@/lib/gateway/install";
import type { DeploymentMode } from "@/lib/gateway/secretsFile";
import { reconcileGateway, registryDrift } from "@/lib/gateway/reconcile";
import {
  refuseNewerThanCli,
  type CandidateRelease,
  type GatewayRelease,
} from "@/lib/gateway/release";
import {
  maySetupLinkBeShown,
  mintSetupLink,
  openInBrowser,
  readOwner,
  waitForSetupLink,
  type GatewayOwner,
} from "@/lib/gateway/setup-link";
import { CLI, thisCommandWithout } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { askText, choose } from "@/lib/output/prompt";
import { deployGatewayRelease, gatewayTarget } from "./deployGateway";

export interface SetupFlags {
  domain?: string;
  /** The Gateway release to deploy: a GitHub repository, a tarball's URL, or a file. */
  release?: string;
  /** What a new Gateway is: self_hosted (the default) or hosted. */
  mode?: DeploymentMode;
  "account-id"?: string;
  "force-dns"?: boolean;
  /** Put a Gateway older than the live one back on purpose (hidden). */
  "allow-downgrade"?: boolean;
  /** Upload the Gateway even when it is up to date (hidden; key rotation). */
  redeploy?: boolean;
  json?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

/**
 * What only a person at a terminal answers: where the gateway goes, when
 * there is no --domain. Nothing asks for a go-ahead: the first lines say
 * which account and where.
 */
interface SetupPrompts {
  /** The zone a Gateway `deploy` offers to install goes under (apps.<zone>). */
  pickZone(zones: string[]): Promise<string>;
  /** The Gateway's address, under one of `zones`. */
  gatewayAddress(zones: string[]): Promise<string>;
}

/** Everything setup reaches outside itself; tests swap in fakes. */
export interface SetupDeps {
  createCf: (accountId?: string) => CfRunner;
  /** The release to deploy (lib/gateway/source.ts). */
  openRelease: () => Promise<GatewayRelease>;
  /** What that release is, without building it from a checkout. */
  source: () => Promise<CandidateRelease>;
  /** A person is at this terminal, and this isn't a --json run. */
  interactive: boolean;
  prompts: SetupPrompts;
  openBrowser: (url: string) => Promise<void>;
  cliVersion: string;
  /** Seams for the deploys' waits and requests (tests). */
  seams?: {
    sleep?: (ms: number) => Promise<void>;
    leaseWaitMs?: number;
    certificates?: {
      probe?: (url: string) => Promise<HttpsAnswer>;
      sleep?: (ms: number) => Promise<void>;
      maxWaitMs?: number;
    };
    /** The one plain request to the gateway before the owner link. */
    fetch?: typeof fetch;
    /** The wait for the owner link's claim. */
    owner?: {
      timeoutMs?: number;
      intervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
    };
  };
}

/** What setup did to the Gateway. */
type GatewayOutcome = "installed" | "upgraded" | "repaired" | "up-to-date";

interface SetupResult {
  gatewayUrl: string;
  /** The Cloudflare account it is in, as a person knows it. */
  account: string;
  /** Its owner's email; null while nobody has claimed it (in CI). */
  owner: string | null;
  organizationName: string | null;
  /** The release the Gateway runs now. */
  release: string;
  gateway: GatewayOutcome;
  /** This run made the owner (with the setup link it handed out). */
  ownerCreated: boolean;
}

/** setup's own dependencies, deploying `gateway`'s release. */
export function setupDeps({
  gateway,
  interactive,
}: {
  gateway: Pick<SetupDeps, "openRelease" | "source">;
  interactive: boolean;
}): SetupDeps {
  return {
    createCf: (accountId) => createCfRunner({ accountId }),
    openRelease: gateway.openRelease,
    source: gateway.source,
    interactive,
    prompts: terminalPrompts,
    openBrowser: openInBrowser,
    cliVersion: packageVersion,
  };
}

export async function runSetup(
  flags: SetupFlags,
  out: EventSink,
  deps: SetupDeps,
): Promise<SetupResult> {
  // Before anything is asked of Cloudflare: a --domain that isn't a hostname.
  const domain = domainFlag(flags.domain);
  checkToolchain(out);

  // Cloudflare: login, then the Gateway the login's accounts have.
  const whoami = await ensureCfAuth({
    cf: deps.createCf(),
    interactive: deps.interactive,
    onDeviceLogin: flags.json ? deviceLoginAction(out, "setup.auth") : undefined,
  });
  out.emit({
    type: "step",
    step: "setup.auth",
    status: "ok",
    message: `Logged in to Cloudflare${whoami.email ? ` as ${whoami.email}` : ""}`,
    data: { email: whoami.email ?? null },
  });
  const discovery = await discoverGateway({
    whoami,
    createCf: deps.createCf,
    accountId: flags["account-id"],
    host: domain,
    hostFlag: "--domain",
    interactive: deps.interactive,
  });
  return installGateway({ whoami, discovery, flags, out, deps });
}

/** --domain, as a hostname; one that isn't is refused in the flag's name. */
function domainFlag(value: string | undefined): string | undefined {
  try {
    return normalizeHostname(value);
  } catch (error) {
    if (!(error instanceof EveryAppError)) throw error;
    throw new EveryAppError(error.code, `--domain ${value} isn't a full hostname`, {
      fix: error.fix,
    });
  }
}

/**
 * Everything after the login: the account, the release, the plan, where
 * the Gateway lives, the Gateway itself and its owner. `deploy` runs it as
 * it is when the login finds no Gateway and a person agrees to install one.
 */
export async function installGateway({
  whoami,
  discovery,
  flags,
  out,
  deps,
}: {
  whoami: CfWhoami;
  discovery: Discovery;
  flags: SetupFlags;
  out: EventSink;
  deps: SetupDeps;
}): Promise<SetupResult> {
  // With no Gateway, where to install one.
  const found = discovery.gateway;
  const account =
    found?.account ??
    (await resolveAccount({
      whoami,
      flag: flags["account-id"],
      interactive: deps.interactive,
    }));
  const accountName = account.name ?? account.id;
  const cf = found?.cf ?? deps.createCf(account.id);
  const install = found?.install ?? null;
  // An install that stopped before its first upload isn't live yet.
  const live = install?.liveVersionId ? install : null;
  out.emit({
    type: "step",
    step: "setup.account",
    status: "ok",
    message: `Setting up Every App in ${accountName}`,
    data: {
      id: account.id,
      name: account.name,
      email: whoami.email ?? null,
      gateway: live !== null,
    },
  });
  assertModeUnchanged(live, flags.mode);

  // What this run deploys, before anything is asked or created.
  const source = await deps.source();
  if (source.minCli) {
    refuseNewerThanCli({ version: source.version, minCli: source.minCli }, deps.cliVersion);
  }
  if (!live) await checkPlan(cf, account.id, out);

  // Where the gateway lives, and nothing in the way of a new address.
  const target = await gatewayTarget({
    cf,
    accountId: account.id,
    install,
    domain:
      domainFlag(flags.domain) ??
      install?.gatewayHost ??
      (await pickDomain(cf, account.id, deps)),
    out,
  });
  const newHost = !live?.liveDomains.includes(target.domain);
  if (newHost) {
    await preflightDomains({
      cf,
      out,
      step: "gateway.domains",
      zone: target.zone,
      domains: [target.domain],
      liveDomains: [],
      forceDns: flags["force-dns"],
      cfAsks: deps.interactive && out.verbose,
    });
  }
  out.emit({
    type: "step",
    step: "setup.domain",
    status: "ok",
    message: `Apps will live one level below ${target.appBaseDomain}`,
    data: {
      gatewayHost: target.domain,
      appBaseDomain: target.appBaseDomain,
      zone: target.zone.name,
    },
  });

  // The gateway.
  const gatewayUrl = `https://${target.domain}`;
  const gateway = await deployOrRepairGateway({
    cf,
    accountId: account.id,
    accountName,
    install,
    databaseId: found?.databaseId ?? null,
    target,
    source,
    checkedDomains: newHost ? [target.domain] : [],
    flags,
    out,
    deps,
  });

  // Its owner.
  const { owner, created } = await ensureOwner({
    db: gateway.db,
    gatewayUrl,
    flags,
    out,
    deps,
  });

  return {
    gatewayUrl,
    account: accountName,
    owner: owner?.email ?? null,
    organizationName: owner?.organizationName || null,
    release: gateway.release,
    gateway: gateway.outcome,
    ownerCreated: created,
  };
}

function checkToolchain(out: EventSink): void {
  // bin/cli.ts already refused a Node too old for cf, and Bun.
  out.emit({
    type: "step",
    step: "setup.toolchain",
    status: "ok",
    message: `Node ${process.versions.node}, cf ${PINNED_CF_VERSION}`,
    data: { node: process.versions.node, cf: PINNED_CF_VERSION },
  });
}

/**
 * The Free plan can't run Every App: D1 stops answering for the rest of
 * the day once a database reaches its daily row limits (enforced since
 * 2026-09-01), and the gateway reads D1 on every request; requests get
 * 10 ms of CPU; an account has 10 databases. A plan that reads as Free
 * stops a new install before anything is created; one that can't be told
 * is warned about (or, when cf couldn't read it, noted with --verbose):
 * Cloudflare refusing the upload for the plan still stops the run then
 * (`upgrade_workers_paid`, lib/cf/deploy.ts).
 */
async function checkPlan(
  cf: CfRunner,
  accountId: string,
  out: EventSink,
): Promise<void> {
  const plan = await workersPlan(cf);
  const url = workersPlansUrl(accountId);
  switch (plan) {
    case WorkersPlan.Paid:
      out.emit({
        type: "step",
        step: "setup.plan",
        status: "ok",
        message: "Account is on Workers Paid",
        data: { plan },
      });
      return;
    case WorkersPlan.Free:
      throw new ActionRequiredError(
        "upgrade_workers_paid",
        "Subscribe this account to Workers Paid\nIt's on the Free plan. Every App needs Workers Paid ($5 a month, then usage): on Free, the Gateway stops once D1 hits its daily limit.",
        url,
        { data: { plan } },
      );
    case WorkersPlan.Unknown:
      out.emit({
        type: "warning",
        code: "WORKERS_PAID_UNVERIFIED",
        step: "setup.plan",
        message:
          "Couldn't confirm this account is on Workers Paid\nEvery App needs it ($5 a month, then usage). On Free, the Gateway stops once D1 hits its daily limit.",
        data: { url, plan },
      });
      return;
    case WorkersPlan.Unreadable:
      out.emit({
        type: "step",
        step: "setup.plan",
        status: "skip",
        message: "Couldn't read this account's plan; Cloudflare refuses the upload if it's on Free",
        data: { url, plan },
      });
      return;
  }
}

/**
 * The account's zones a Gateway can live under: active ones, or the
 * `add_domain` action when there is none yet.
 */
export async function activeZones(cf: CfRunner, accountId: string): Promise<string[]> {
  const zones = await listZones(cf, accountId);
  const active = zones.filter((zone) => !zone.status || zone.status === "active");
  if (active.length > 0) return active.map((zone) => zone.name);
  const [pending] = zones;
  if (pending) {
    throw new ActionRequiredError(
      "add_domain",
      `Finish activating ${zones.map((zone) => zone.name).join(", ")} on Cloudflare\n${zones.length === 1 ? "Its nameservers don't" : "Their nameservers don't"} point at Cloudflare yet.`,
      zoneUrl(accountId, pending.name),
    );
  }
  throw new ActionRequiredError(
    "add_domain",
    "Add a domain to this Cloudflare account\nEvery App needs one. Buy one in the dashboard (about $10 a year for a .com, ready in minutes),\nor point a domain you own at Cloudflare's nameservers.",
    registerDomainUrl(accountId),
  );
}

/** The gateway's address, typed at the terminal under one of the account's zones. */
async function pickDomain(
  cf: CfRunner,
  accountId: string,
  deps: SetupDeps,
): Promise<string> {
  const zones = await activeZones(cf, accountId);
  if (!deps.interactive) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      `Choose the Gateway's address with --domain\nIt must be under one of this account's domains: ${zones.join(", ")}. A subdomain works best.`,
      {
        fix: `add --domain apps.${zones[0]!}, or another name under ${orList(zones)}`,
        data: { zones },
      },
    );
  }
  return normalizeHostname(await deps.prompts.gatewayAddress(zones));
}

/** "a", "a or b", "a, b or c". */
function orList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * The Gateway this run deploys (`source`, lib/gateway/source.ts), live:
 * installed, upgraded, or when it already runs these sources (told by the
 * install row's tree hash, before anything is built) or this very release,
 * repaired if its bindings or hostnames aren't the registry's. A Gateway
 * behind the live release is refused, unless --allow-downgrade.
 */
async function deployOrRepairGateway({
  cf,
  accountId,
  accountName,
  install,
  databaseId,
  target,
  source,
  checkedDomains,
  flags,
  out,
  deps,
}: {
  cf: CfRunner;
  accountId: string;
  accountName: string;
  install: InstallRecord | null;
  databaseId: string | null;
  target: Awaited<ReturnType<typeof gatewayTarget>>;
  source: CandidateRelease;
  checkedDomains: string[];
  flags: SetupFlags;
  out: EventSink;
  deps: SetupDeps;
}): Promise<{ db: D1Database; release: string; outcome: GatewayOutcome }> {
  const gatewayUrl = `https://${target.domain}`;
  const live = install?.liveVersionId ? install : null;
  const allowDowngrade = flags["allow-downgrade"] ?? false;
  const repair = (openRelease: () => Promise<GatewayRelease>) =>
    repairGateway({
      cf,
      accountId,
      accountName,
      install: live!,
      databaseId: databaseId!,
      openRelease,
      flags,
      out,
      deps,
    });
  if (live && databaseId) {
    // Before building: a minute or two, for nothing, on a fresh machine.
    if (
      (source.treeSha256 && source.treeSha256 === live.sourceTreeSha256) ||
      (source.sha256 && source.sha256 === live.releaseSha256)
    ) {
      return repair(deps.openRelease);
    }
    if (!allowDowngrade) refuseDowngrade(source, live, { allowDowngradeFlag: true });
  }

  // Said before the release is opened: a checkout's build takes a minute or two.
  out.emit({
    type: "step",
    step: "setup.gateway",
    status: "start",
    message: live
      ? `Upgrading the Gateway ${live.releaseVersion} → ${source.version}`
      : `Installing Gateway ${source.version} at ${target.domain}`,
    data: {
      change: live
        ? GatewayChange.Upgrade
        : install?.gatewayHost === target.domain
          ? GatewayChange.Resume
          : GatewayChange.Install,
      release: source.version,
      from: live?.releaseVersion ?? null,
      gatewayUrl,
      account: accountName,
    },
  });
  const release = await deps.openRelease();
  try {
    const manifest = release.manifest;
    refuseNewerThanCli(manifest, deps.cliVersion);
    if (live && databaseId) {
      if (isLiveRelease(release, live)) return await repair(async () => release);
      if (!allowDowngrade) {
        refuseDowngrade(candidate(release), live, { allowDowngradeFlag: true });
      }
    }
    const { result, db } = await deployGatewayRelease({
      cf,
      out,
      reason: live ? "upgrade" : "deploy",
      release,
      accountId,
      target,
      interactive: deps.interactive,
      forceDns: flags["force-dns"],
      checkedDomains,
      allowDowngrade,
      allowDowngradeFlag: true,
      deploymentMode: flags.mode,
      sleep: deps.seams?.sleep,
      leaseWaitMs: deps.seams?.leaseWaitMs,
      certificates: deps.seams?.certificates,
    });
    out.emit({
      type: "step",
      step: "setup.gateway",
      status: "ok",
      message: `Gateway ${manifest.version} is live at ${gatewayUrl}`,
      data: { versionId: result.versionId, release: manifest.version },
    });
    return {
      db,
      release: manifest.version,
      outcome: live ? "upgraded" : "installed",
    };
  } finally {
    await release.cleanup();
  }
}

/** The modes as a person reads them. */
const MODE_NAMES: Readonly<Record<DeploymentMode, string>> = {
  self_hosted: "self-hosted",
  hosted: "hosted",
};

/**
 * --mode decides what a new Gateway is: its first upload sets
 * GATEWAY_DEPLOYMENT_MODE, and nothing changes it after. On a live Gateway
 * the flag may only say what its install row recorded.
 */
function assertModeUnchanged(
  live: InstallRecord | null,
  mode: DeploymentMode | undefined,
): void {
  if (!mode || !live?.deploymentMode || live.deploymentMode === mode) return;
  throw new EveryAppError(
    "MODE_CHANGE_UNSUPPORTED",
    `This Gateway is ${MODE_NAMES[live.deploymentMode]} and can't be switched to ${MODE_NAMES[mode]}`,
    {
      rerun: thisCommandWithout("--mode"),
      rerunNote: "(without --mode) to update it as it is",
      data: { installed: live.deploymentMode, requested: mode },
    },
  );
}

/**
 * A Gateway that runs the release this run deploys: left alone when it binds and
 * publishes exactly the apps its registry lists and serves the version its
 * install row names; otherwise (or with --redeploy) redeployed with them.
 */
async function repairGateway({
  cf,
  accountId,
  accountName,
  install,
  databaseId,
  openRelease,
  flags,
  out,
  deps,
}: {
  cf: CfRunner;
  accountId: string;
  accountName: string;
  install: InstallRecord;
  databaseId: string;
  openRelease: () => Promise<GatewayRelease>;
  flags: SetupFlags;
  out: EventSink;
  deps: SetupDeps;
}): Promise<{ db: D1Database; release: string; outcome: GatewayOutcome }> {
  const db = cfD1Database(cf, databaseId);
  const gatewayUrl = `https://${install.gatewayHost}`;
  const release = install.releaseVersion;
  const { inSync, desired } = await registryDrift(cf, db, install);
  if (inSync && !flags.redeploy) {
    out.emit({
      type: "step",
      step: "setup.gateway",
      status: "skip",
      message: `Gateway ${release} is up to date`,
      data: {
        release,
        gatewayUrl,
        upToDate: true,
        account: accountName,
        apps: desired.appWorkers.length,
      },
    });
    return { db, release, outcome: "up-to-date" };
  }
  // The apps the live Gateway doesn't route yet, by their names.
  const added = [
    ...new Set(
      desired.apps
        .filter((app) => !install.liveAppWorkers.includes(app.workerName))
        .map((app) => app.appId),
    ),
  ].sort();
  out.emit({
    type: "step",
    step: "setup.gateway",
    status: "start",
    message: inSync
      ? `Redeploying the Gateway ${release} (--redeploy)`
      : `Repairing the Gateway ${release}: ${desired.appWorkers.length} apps, was ${install.liveAppWorkers.length}`,
    data: {
      change: inSync ? GatewayChange.Redeploy : GatewayChange.Repair,
      release,
      from: release,
      gatewayUrl,
      account: accountName,
      apps: desired.appWorkers.length,
      was: install.liveAppWorkers.length,
      redeploy: inSync,
    },
  });
  const result = await reconcileGateway({
    cf,
    out,
    accountId,
    databaseId,
    openRelease,
    interactive: deps.interactive,
    cliVersion: deps.cliVersion,
    force: true,
    forceDns: flags["force-dns"],
    sleep: deps.seams?.sleep,
    leaseWaitMs: deps.seams?.leaseWaitMs,
  });
  await waitForCertificates({
    hosts: result.newHosts,
    out,
    step: "gateway.tls",
    ...deps.seams?.certificates,
  });
  out.emit({
    type: "step",
    step: "setup.gateway",
    status: "ok",
    message: inSync
      ? `Gateway ${release} redeployed`
      : `Gateway ${release} routes ${result.appWorkers.length} apps`,
    data: {
      versionId: result.versionId,
      release,
      appWorkers: result.appWorkers,
      ...(inSync
        ? {}
        : {
            repaired: true,
            added,
            apps: result.appWorkers.length,
            was: install.liveAppWorkers.length,
          }),
    },
  });
  return { db, release, outcome: "repaired" };
}

/**
 * The gateway's owner: there already, or made with a one-time setup link
 * this run mints (and opens, at a terminal), waiting up to 15 minutes for
 * the claim by reading the link's own row in D1. A resumed setup mints a
 * new link, and the one shown before stops working. Apps don't need an
 * owner; people do, to sign in. In CI there is no one to hand the link to:
 * the run ends with the Gateway installed and a warning (exit 0).
 */
async function ensureOwner({
  db,
  gatewayUrl,
  flags,
  out,
  deps,
}: {
  db: D1Database;
  gatewayUrl: string;
  flags: SetupFlags;
  out: EventSink;
  deps: SetupDeps;
}): Promise<{ owner: GatewayOwner | null; created: boolean }> {
  const existing = await readOwner(db);
  if (existing) {
    out.emit({
      type: "step",
      step: "setup.owner",
      status: "skip",
      message: `Owner account is ${existing.email}`,
      data: { ...existing },
    });
    return { owner: existing, created: false };
  }
  // A CI log is no place for a link that makes whoever opens it the
  // owner: it goes to a person at this terminal, or in the --json events
  // an agent on this machine hands on.
  if (!maySetupLinkBeShown({ terminal: deps.interactive, relayed: flags.json })) {
    out.emit({
      type: "warning",
      code: "OWNER_NOT_CLAIMED",
      step: "setup.owner",
      message:
        "The Gateway has no owner yet\nApps deploy without one. To create it, run setup at a terminal with this Cloudflare login.",
      data: { rerun: `${CLI} setup`, rerunNote: "at a terminal", needsTerminal: true },
    });
    return { owner: null, created: false };
  }
  await checkReachable(gatewayUrl, out, deps.seams?.fetch);

  const link = await mintSetupLink({ db, gatewayUrl });
  const expiresIn = () => roughly(link.expiresAt.getTime() - Date.now());
  out.emit({
    type: "action_required",
    action: "claim_owner",
    step: "setup.owner",
    message: link.replaced
      ? `Open this new link to create the owner account\nThe link shown before no longer works. This one works once and expires in ${expiresIn()}. Treat it like a password.`
      : `Open this link to create the owner account\nWorks once and expires in ${expiresIn()}. Treat it like a password.`,
    data: {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      replaced: link.replaced,
      waiting: true,
      waitingFor: "the owner account",
    },
  });
  if (deps.interactive) await deps.openBrowser(link.url);

  const waitStarted = Date.now();
  const state = await waitForSetupLink({ db, id: link.id, ...deps.seams?.owner });
  // A newer link replaced this one: whoever has it may have used it.
  const owner =
    state.status === "claimed"
      ? (state.owner ?? (await readOwner(db)))
      : state.status === "gone"
        ? await readOwner(db)
        : null;
  if (owner) {
    out.emit({
      type: "step",
      step: "setup.owner",
      status: "ok",
      message: `Owner account created for ${owner.email}`,
      data: { ...owner },
    });
    return { owner, created: true };
  }
  if (state.status === "waiting") {
    // The link is on the screen already: not shown again.
    throw new ActionRequiredError(
      "claim_owner",
      `Open the setup link above to create the owner account\nNobody opened it within ${roughly(Date.now() - waitStarted)}. It still works for ${expiresIn()}; running setup before it's opened replaces it.`,
      undefined,
      {
        rerun: `${CLI} setup`,
        rerunNote: "to finish",
        data: { setupUrl: link.url, expiresAt: link.expiresAt.toISOString() },
      },
    );
  }
  throw new ActionRequiredError(
    "claim_owner",
    "Use the newer setup link, or get a new one\nThis link stopped working before anyone used it: setup ran again on another machine, or it expired.",
    undefined,
    { rerun: `${CLI} setup`, rerunNote: "for a new link" },
  );
}

/** Why a gateway that doesn't answer may not, in a person's words. */
const unreachableBecause: Record<NoAnswerKind, (host: string, reason: string) => string> = {
  tls: () => "Its certificate is probably still on the way (TLS handshake failed).",
  dns: (host) => `DNS has no address for ${host} yet.`,
  other: (_host, reason) => `It didn't answer (${reason}).`,
};

/**
 * One plain request to the gateway before the owner link goes out, so a
 * certificate still on its way, a name that doesn't resolve, or Cloudflare
 * Access in front, shows up here rather than on the person's screen. The
 * link is shown either way.
 */
async function checkReachable(
  gatewayUrl: string,
  out: EventSink,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const host = new URL(gatewayUrl).host;
  const answer = await probeHttps(`${gatewayUrl}/`, fetchImpl);
  if (!answer.answered) {
    out.emit({
      type: "warning",
      code: "GATEWAY_UNREACHABLE",
      step: "setup.owner",
      message: `${host} doesn't answer over HTTPS yet\n${unreachableBecause[answer.kind](host, answer.reason)} The link below works as soon as it does.`,
      data: { kind: answer.kind, reason: answer.reason },
    });
  } else if (answer.access) {
    out.emit({
      type: "warning",
      code: "ACCESS_IN_FRONT",
      step: "setup.owner",
      message: `Cloudflare Access protects ${host}\nWhoever opens the setup link signs in to Access first.`,
    });
  }
}

/** The questions setup asks a person at the terminal. */
const terminalPrompts: SetupPrompts = {
  pickZone: (zones: string[]) =>
    choose(
      "Which of your domains should Every App live under?",
      zones.map((zone) => ({ label: zone, value: zone })),
    ),
  gatewayAddress: (zones: string[]) =>
    askText("Gateway address", {
      context: [
        zones.length === 1
          ? `Apps get addresses one level below the Gateway, e.g. todo.apps.${zones[0]!}`
          : `Your domains: ${zones.join(", ")}. Apps live one level below the Gateway.`,
      ],
      initial: `apps.${zones[0]!}`,
      validate: (value) => {
        let host: string;
        try {
          host = normalizeHostname(value);
        } catch {
          return `Enter a hostname like apps.${zones[0]!}`;
        }
        return zones.some((zone) => host === zone || host.endsWith(`.${zone}`))
          ? null
          : `Use a name under ${orList(zones)}`;
      },
    }),
};
