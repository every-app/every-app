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
 *    plan        Workers Paid: warned about, never required
 *    domain      where the gateway lives: --domain, the install row's (also
 *                one an install wrote before it stopped), or a zone picked
 *                at the terminal (apps.<zone>)
 *    gateway     installed, or upgraded to the release --release names,
 *                this checkout builds, or without a checkout, the latest
 *                published one (lib/gateway/source.ts); when it runs that
 *                release already (told by the install row's tree hash
 *                before anything is built, or the release's SHA-256), repaired:
 *                redeployed only if it doesn't bind and publish exactly the
 *                apps its registry lists, or serves a version the row
 *                doesn't name (lib/gateway/reconcile.ts), or --redeploy. A
 *                Gateway behind the live one is refused (git pull), unless
 *                --allow-downgrade
 *    owner       a one-time setup link, opened in the browser (never put
 *                into a CI log), and the wait for the claim, read from the
 *                link's own row in D1
 *
 * What can be set up next (AI, email) is the command's `done.data.next`.
 * With --json, each step is an NDJSON event and what only a person can do
 * is `action_required`; a run that stops on one exits 2, and running the
 * same command again resumes it.
 */
import { version as packageVersion } from "../../../package.json";
import chalk from "chalk";
import { roughly } from "@/lib/output/roughly";
import enquirer from "enquirer";
import {
  deviceLoginAction,
  ensureCfAuth,
  resolveAccount,
} from "@/lib/cf/account";
import { PINNED_CF_VERSION } from "@/lib/cf/bin";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { hasWorkersPaid } from "@/lib/cf/plan";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { waitForCertificates } from "@/lib/domains/certWait";
import { normalizeHostname } from "@/lib/domains/hostnames";
import {
  probeHttps,
  type HttpsAnswer,
  type NoAnswerKind,
} from "@/lib/domains/https";
import { listZones, registerDomainUrl } from "@/lib/domains/zones";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import {
  candidate,
  downgradeRefused,
  isLiveRelease,
  olderThanInstalled,
  type CandidateRelease,
} from "@/lib/gateway/apply";
import { discoverGateway, type Discovery } from "@/lib/gateway/discover";
import type { InstallRecord } from "@/lib/gateway/install";
import type { DeploymentMode } from "@/lib/gateway/secretsFile";
import { reconcileGateway, registryDrift } from "@/lib/gateway/reconcile";
import { refuseNewerThanCli, type GatewayRelease } from "@/lib/gateway/release";
import {
  maySetupLinkBeShown,
  mintSetupLink,
  openInBrowser,
  readOwner,
  waitForSetupLink,
  type GatewayOwner,
} from "@/lib/gateway/setup-link";
import { gatewayReleaseSource } from "@/lib/gateway/source";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { handTerminalOver } from "@/lib/output/terminal";
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
  pickZone(zones: string[]): Promise<string>;
  hostname(zone: string): Promise<string>;
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
  organizationName: string | null;
  /** The release the Gateway runs now. */
  release: string;
  gateway: GatewayOutcome;
  /** This run made the owner (with the setup link it handed out). */
  ownerCreated: boolean;
}

/** setup's own dependencies, for a run at this terminal or under --json. */
export function setupDeps({
  out,
  json,
  verbose,
  release,
}: {
  out: EventSink;
  json?: boolean;
  verbose?: boolean;
  /** --release */
  release?: string;
}): SetupDeps {
  const gateway = gatewayReleaseSource({ release, out, verbose });
  return {
    createCf: (accountId) => createCfRunner({ accountId }),
    openRelease: gateway.open,
    source: gateway.describe,
    interactive: canPromptInTerminal(json ?? false),
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
    message: `Logged in to Cloudflare${whoami.email ? ` as ${whoami.email}` : ""}.`,
    data: { email: whoami.email ?? null },
  });
  const discovery = await discoverGateway({
    whoami,
    createCf: deps.createCf,
    accountId: flags["account-id"],
    host: normalizeHostname(flags.domain),
    interactive: deps.interactive,
  });
  return installGateway({ whoami, discovery, flags, out, deps });
}

/**
 * Everything after the login: the account, the plan, where the Gateway
 * lives, the Gateway itself and its owner. `deploy` runs it as it is when
 * the login finds no Gateway and a person agrees to install one.
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
  const cf = found?.cf ?? deps.createCf(account.id);
  out.emit({
    type: "step",
    step: "setup.account",
    status: "ok",
    message: `Using Cloudflare account ${account.name ?? account.id}.`,
    data: { id: account.id, name: account.name, email: whoami.email ?? null },
  });
  await checkPlan(cf, account.id, out);

  // Where the gateway lives.
  const databaseId = found?.databaseId ?? null;
  const install = found?.install ?? null;
  const domain =
    normalizeHostname(flags.domain) ??
    install?.gatewayHost ??
    (await pickDomain(cf, account.id, deps));
  const target = await gatewayTarget({
    cf,
    accountId: account.id,
    install,
    domain,
    out,
  });
  out.emit({
    type: "step",
    step: "setup.domain",
    status: "ok",
    message: `The gateway lives at https://${target.domain}, each app one label below it (todo.${target.appBaseDomain}) as its own Custom Domain.`,
    data: {
      gatewayHost: target.domain,
      appBaseDomain: target.appBaseDomain,
      zone: target.zone.name,
    },
  });

  // The gateway.
  assertModeUnchanged(install, flags.mode);
  const gatewayUrl = `https://${target.domain}`;
  const gateway = await deployOrRepairGateway({
    cf,
    account,
    install,
    databaseId,
    target,
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
    organizationName: owner.organizationName || null,
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
    message: `Node ${process.versions.node}, cf ${PINNED_CF_VERSION}.`,
    data: { node: process.versions.node, cf: PINNED_CF_VERSION },
  });
}

/**
 * The Free plan can't run Every App: D1 stops answering for the rest of
 * the day once a database reaches its daily row limits (enforced since
 * 2026-09-01), and the gateway reads D1 on every request; requests get
 * 10 ms of CPU; an account has 10 databases. Warned about, never asked or
 * required: the subscription's shape isn't verified, so a paid account
 * could read as unknown. When Cloudflare itself refuses for the plan, the
 * run stops with `upgrade_workers_paid` (lib/cf/deploy.ts, report.ts).
 */
async function checkPlan(
  cf: CfRunner,
  accountId: string,
  out: EventSink,
): Promise<void> {
  if (await hasWorkersPaid(cf)) {
    out.emit({
      type: "step",
      step: "setup.plan",
      status: "ok",
      message: "The account is on Workers Paid.",
    });
    return;
  }
  const url = `https://dash.cloudflare.com/${accountId}/workers/plans`;
  out.emit({
    type: "warning",
    code: "WORKERS_PAID_UNVERIFIED",
    step: "setup.plan",
    message: `Couldn't confirm this account is on Workers Paid ($5 a month, then usage). Every App needs it: on the Free plan D1 stops answering for the rest of the day once it reaches its daily limits (and the gateway reads D1 on every request), requests get 10 ms of CPU, and an account has 10 databases. Subscribe at ${url}.`,
    data: { url },
  });
}

/**
 * The account's zones a Gateway can live under: active ones, or the
 * `add_domain` action when there is none yet.
 */
export async function activeZones(cf: CfRunner, accountId: string): Promise<string[]> {
  const zones = await listZones(cf, accountId);
  const active = zones.filter((zone) => !zone.status || zone.status === "active");
  if (active.length > 0) return active.map((zone) => zone.name);
  const pending = zones.map((zone) => zone.name);
  throw new ActionRequiredError(
    "add_domain",
    pending.length > 0
      ? `${pending.join(", ")} ${pending.length === 1 ? "isn't" : "aren't"} active yet: finish ${pending.length === 1 ? "its" : "their"} nameserver setup in the Cloudflare dashboard, then run this command again.`
      : `Every App needs a domain on Cloudflare, and this account has none. Buy one in the Cloudflare dashboard: Domains → Buy a domain (${registerDomainUrl(accountId)}; a Worker's Domains tab sells them too). Cloudflare Registrar charges what the registry does, about $10 a year for a .com, and the domain is ready in minutes with nothing to configure. Or add a domain you own and point its nameservers at Cloudflare. Then run this command again; a subdomain of it works best, e.g. apps.<your domain>.`,
    registerDomainUrl(accountId),
  );
}

/** A hostname for the gateway, picked at the terminal from the account's zones. */
async function pickDomain(
  cf: CfRunner,
  accountId: string,
  deps: SetupDeps,
): Promise<string> {
  const zones = await activeZones(cf, accountId);
  if (!deps.interactive) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      `Pass --domain with a hostname in one of this account's zones, e.g. --domain apps.${zones[0]!}. Zones: ${zones.join(", ")}.`,
      { rerun: `${CLI} setup --domain apps.${zones[0]!}` },
    );
  }
  const zone = zones.length === 1 ? zones[0]! : await deps.prompts.pickZone(zones);
  return normalizeHostname(await deps.prompts.hostname(zone));
}

/**
 * The Gateway this run deploys (lib/gateway/source.ts), live: installed,
 * upgraded, or when it already runs these sources (told by the install
 * row's tree hash, before anything is built) or this very release,
 * repaired if its bindings or hostnames aren't the registry's. A Gateway
 * behind the live release is refused, unless --allow-downgrade.
 */
async function deployOrRepairGateway({
  cf,
  account,
  install,
  databaseId,
  target,
  flags,
  out,
  deps,
}: {
  cf: CfRunner;
  account: { id: string; name: string | null };
  install: InstallRecord | null;
  databaseId: string | null;
  target: Awaited<ReturnType<typeof gatewayTarget>>;
  flags: SetupFlags;
  out: EventSink;
  deps: SetupDeps;
}): Promise<{ db: D1Database; release: string; outcome: GatewayOutcome }> {
  const gatewayUrl = `https://${target.domain}`;
  // An install that stopped before its first upload isn't live yet.
  const live = install?.liveVersionId ? install : null;
  const allowDowngrade = flags["allow-downgrade"] ?? false;
  const repair = (openRelease: () => Promise<GatewayRelease>) =>
    repairGateway({
      cf,
      accountId: account.id,
      install: live!,
      databaseId: databaseId!,
      openRelease,
      flags,
      out,
      deps,
    });
  if (live && databaseId) {
    // Before building: a minute or two, for nothing, on a fresh machine.
    const source = await deps.source();
    if (
      (source.treeSha256 && source.treeSha256 === live.sourceTreeSha256) ||
      (source.sha256 && source.sha256 === live.releaseSha256)
    ) {
      return repair(deps.openRelease);
    }
    if (!allowDowngrade && olderThanInstalled(source, live)) {
      throw downgradeRefused(source, live, { allowDowngradeFlag: true });
    }
  }

  const release = await deps.openRelease();
  try {
    const manifest = release.manifest;
    refuseNewerThanCli(manifest, deps.cliVersion);
    if (live && databaseId) {
      if (isLiveRelease(release, live)) return await repair(async () => release);
      if (!allowDowngrade && olderThanInstalled(candidate(release), live)) {
        throw downgradeRefused(candidate(release), live, { allowDowngradeFlag: true });
      }
    }
    out.emit({
      type: "step",
      step: "setup.gateway",
      status: "start",
      message: live
        ? `Upgrading the gateway to release ${manifest.version}...`
        : `Installing the gateway at ${gatewayUrl} in ${account.name ?? account.id}...`,
      data: {
        release: manifest.version,
        from: live?.releaseVersion ?? null,
        gatewayUrl,
      },
    });
    const { result, db } = await deployGatewayRelease({
      cf,
      out,
      reason: live ? "upgrade" : "deploy",
      release,
      accountId: account.id,
      target,
      interactive: deps.interactive,
      forceDns: flags["force-dns"],
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
      message: `Gateway ${manifest.version} is live at https://${target.domain}.`,
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

/**
 * --mode decides what a new Gateway is: its first upload sets
 * GATEWAY_DEPLOYMENT_MODE, and nothing changes it after. On a live Gateway
 * the flag may only say what its install row recorded.
 */
function assertModeUnchanged(
  install: InstallRecord | null,
  mode: DeploymentMode | undefined,
): void {
  if (!mode || !install?.liveVersionId || install.deploymentMode === mode) {
    return;
  }
  throw new EveryAppError(
    "MODE_CHANGE_UNSUPPORTED",
    `This gateway was installed as ${install.deploymentMode}; changing it to ${mode} isn't supported.`,
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
  install,
  databaseId,
  openRelease,
  flags,
  out,
  deps,
}: {
  cf: CfRunner;
  accountId: string;
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
      message: `Gateway ${release} at ${gatewayUrl} is up to date: the release this run deploys, binding the ${desired.appWorkers.length} app${desired.appWorkers.length === 1 ? "" : "s"} its registry lists.`,
      data: { release, gatewayUrl, upToDate: true },
    });
    return { db, release, outcome: "up-to-date" };
  }
  out.emit({
    type: "step",
    step: "setup.gateway",
    status: "start",
    message: inSync
      ? `Redeploying gateway ${release} (--redeploy)...`
      : `Rebinding gateway ${release}: ${desired.appWorkers.length} app${desired.appWorkers.length === 1 ? "" : "s"} (was ${install.liveAppWorkers.length})...`,
    data: {
      release,
      from: release,
      gatewayUrl,
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
    message: `Gateway ${release} binds ${result.appWorkers.length} app${result.appWorkers.length === 1 ? "" : "s"} (version ${result.versionId ?? "unknown"}).`,
    data: { versionId: result.versionId, release, apps: result.appWorkers },
  });
  return { db, release, outcome: "repaired" };
}

/**
 * The gateway's owner: there already, or made with a one-time setup link
 * this run mints (and opens, at a terminal), waiting up to 15 minutes for
 * the claim by reading the link's own row in D1. A resumed setup mints a
 * new link, and the one shown before stops working. Apps don't need an
 * owner; people do, to sign in.
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
}): Promise<{ owner: GatewayOwner; created: boolean }> {
  const existing = await readOwner(db);
  if (existing) {
    out.emit({
      type: "step",
      step: "setup.owner",
      status: "skip",
      message: `The gateway's owner is ${existing.email}.`,
      data: { ...existing },
    });
    return { owner: existing, created: false };
  }
  // A CI log is no place for a link that makes whoever opens it the
  // owner: it goes to a person at this terminal, or in the --json events
  // an agent on this machine hands on.
  if (!maySetupLinkBeShown({ terminal: deps.interactive, relayed: flags.json })) {
    throw new ActionRequiredError(
      "claim_owner",
      `The Gateway has no owner yet. Run \`${CLI} setup\` at a terminal on any machine with this Cloudflare login to create the owner account; apps deploy without one.`,
      undefined,
      { rerun: `${CLI} setup` },
    );
  }
  await checkReachable(gatewayUrl, out, deps.seams?.fetch);

  const link = await mintSetupLink({ db, gatewayUrl });
  out.emit({
    type: "action_required",
    action: "claim_owner",
    step: "setup.owner",
    message: [
      "Open this link to create the owner account",
      `Works once and expires in ${roughly(link.expiresAt.getTime() - Date.now())}. Treat it like a password.`,
      ...(link.replaced ? ["The setup link shown before no longer works; this one replaces it."] : []),
    ].join("\n"),
    data: {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      waiting: true,
      waitingFor: "the owner account",
    },
  });
  if (deps.interactive) await deps.openBrowser(link.url);

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
      message: `Owner created: ${owner.email}${owner.organizationName ? ` (${owner.organizationName})` : ""}.`,
      data: { ...owner },
    });
    return { owner, created: true };
  }
  if (state.status === "waiting") {
    throw new ActionRequiredError(
      "claim_owner",
      `Nobody has used the setup link yet. It works until ${link.expiresAt.toLocaleString()}: open it, then run \`${CLI} setup\` again to finish. (Run before anyone opens it, setup shows a new link, and this one stops working.)`,
      link.url,
      { rerun: `${CLI} setup` },
    );
  }
  throw new ActionRequiredError(
    "claim_owner",
    `The setup link stopped working before anyone used it: a newer one replaced it (setup on another machine), or it expired. If someone has the newer link, create the owner account with it; otherwise run \`${CLI} setup\` again for a new one.`,
    undefined,
    { rerun: `${CLI} setup` },
  );
}

/** What a gateway that doesn't answer may be waiting for. */
const unreachableBecause: Record<NoAnswerKind, string> = {
  tls: "; its certificate may still be on its way",
  dns: "; DNS has no address for it yet",
  other: "",
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
  const answer = await probeHttps(`${gatewayUrl}/`, fetchImpl);
  if (!answer.answered) {
    out.emit({
      type: "warning",
      code: "GATEWAY_UNREACHABLE",
      step: "setup.owner",
      message: `${gatewayUrl} doesn't answer over HTTPS yet (${answer.reason})${unreachableBecause[answer.kind]}. The setup link works as soon as it does.`,
    });
  } else if (answer.access) {
    out.emit({
      type: "warning",
      code: "ACCESS_IN_FRONT",
      step: "setup.owner",
      message: `Cloudflare Access answers ${gatewayUrl} before the gateway: whoever opens the setup link signs in to Access first.`,
    });
  }
}

/** The questions setup asks a person at the terminal. */
const terminalPrompts: SetupPrompts = {
  async pickZone(zones: string[]): Promise<string> {
    handTerminalOver();
    const { zone } = await enquirer.prompt<{ zone: string }>({
      type: "select",
      name: "zone",
      message: "Which of your domains should Every App live under?",
      choices: zones,
    });
    return zone;
  },
  async hostname(zone: string): Promise<string> {
    handTerminalOver();
    process.stdout.write(
      `${chalk.dim(`Apps get addresses one level below the Gateway, e.g. todo.apps.${zone}; a subdomain keeps the rest of ${zone} out of it.`)}\n`,
    );
    const { hostname } = await enquirer.prompt<{ hostname: string }>({
      type: "input",
      name: "hostname",
      message: "Gateway address",
      initial: `apps.${zone}`,
      validate: (value: string) => {
        try {
          const host = normalizeHostname(value);
          return host === zone || host.endsWith(`.${zone}`)
            ? true
            : `Use ${zone} or a name under it`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    return hostname;
  },
};
