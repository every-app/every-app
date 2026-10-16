/**
 * `everyapp setup`: from an empty Cloudflare account to a working gateway
 * and its owner, in one command. Apps are deployed afterwards (`everyapp
 * app deploy`), with the same Cloudflare login, before or after the owner
 * exists.
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
 *    gateway     deployed, or upgraded to the release this checkout builds
 *                (nothing built when the install row's tree hash is the
 *                checkout's); a checkout behind the live one is refused
 *                (git pull), unless --allow-downgrade
 *    owner       a one-time setup link, opened in the browser (never put
 *                into a CI log, unless --printSetupLink), and the wait for
 *                the claim, read from the link's own row in D1
 *
 * What can be set up next (AI, email) is the command's `done.data.next`.
 * With --json, each step is an NDJSON event and what only a person can do
 * is `action_required`; a run that stops on one exits 2, and running the
 * same command again resumes it.
 */
import {
  deployGatewayRelease,
  gatewayTarget,
} from "@/commands/gateway/deploy/deployGateway";
import {
  deviceLoginAction,
  ensureCfAuth,
  resolveAccount,
} from "@/lib/cf/account";
import { PINNED_CF_VERSION } from "@/lib/cf/bin";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { hasWorkersPaid } from "@/lib/cf/plan";
import type { CfRunner } from "@/lib/cf/runner";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { probeHttps } from "@/lib/domains/https";
import { listZones, registerDomainUrl } from "@/lib/domains/zones";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import {
  candidate,
  downgradeRefused,
  isLiveRelease,
  olderThanInstalled,
} from "@/lib/gateway/apply";
import type { CheckoutSource } from "@/lib/gateway/checkoutRelease";
import { discoverGateway } from "@/lib/gateway/discover";
import type { InstallRecord } from "@/lib/gateway/install";
import { compareVersions, type GatewayRelease } from "@/lib/gateway/release";
import {
  maySetupLinkBeShown,
  mintSetupLink,
  readOwner,
  waitForSetupLink,
  type GatewayOwner,
} from "@/lib/gateway/setup-link";
import type { EventSink } from "@/lib/output/events";

export interface SetupFlags {
  domain?: string;
  "account-id"?: string;
  "allow-free-plan"?: boolean;
  "force-dns"?: boolean;
  /** Put a Gateway older than the live one back on purpose (hidden). */
  "allow-downgrade"?: boolean;
  "no-open"?: boolean;
  /** Show the owner setup link in CI or piped output too (`gateway deploy`'s flag). */
  printSetupLink?: boolean;
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
  /** The release this checkout builds (the build cache's, or a new build). */
  openRelease: () => Promise<GatewayRelease>;
  /** What this checkout's Gateway is, without building it. */
  source: () => Promise<CheckoutSource>;
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
      isReady?: (url: string) => Promise<boolean>;
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

interface SetupResult {
  gatewayUrl: string;
  organizationName: string | null;
}

export async function runSetup(
  flags: SetupFlags,
  out: EventSink,
  deps: SetupDeps,
): Promise<SetupResult> {
  checkToolchain(out);

  // Cloudflare: login, account, plan.
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
  const requestedDomain = normalizeHostname(flags.domain);
  // The Gateway the login's accounts have; with none, where to install one.
  const discovery = await discoverGateway({
    whoami,
    createCf: deps.createCf,
    accountId: flags["account-id"],
    host: requestedDomain,
    interactive: deps.interactive,
  });
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
  await checkPlan(cf, account.id, flags, out);

  // Where the gateway lives.
  const databaseId = found?.databaseId ?? null;
  const install = found?.install ?? null;
  const domain =
    requestedDomain ??
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
  const gatewayUrl = `https://${target.domain}`;
  const db = await deployOrSkipGateway({
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
  const owner = await ensureOwner({ db, gatewayUrl, flags, out, deps });

  return { gatewayUrl, organizationName: owner.organizationName || null };
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
  flags: SetupFlags,
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
  if (flags["allow-free-plan"]) {
    out.emit({
      type: "step",
      step: "setup.plan",
      status: "skip",
      message: "Not checking for Workers Paid (--allow-free-plan).",
    });
    return;
  }
  out.emit({
    type: "warning",
    code: "WORKERS_PAID_UNVERIFIED",
    step: "setup.plan",
    message: `Couldn't confirm this account is on Workers Paid ($5 a month, then usage). Every App needs it: on the Free plan D1 stops answering for the rest of the day once it reaches its daily limits (and the gateway reads D1 on every request), requests get 10 ms of CPU, and an account has 10 databases. Subscribe at ${url}.`,
    data: { url },
  });
}

/** A hostname for the gateway, picked at the terminal from the account's zones. */
async function pickDomain(
  cf: CfRunner,
  accountId: string,
  deps: SetupDeps,
): Promise<string> {
  const zones = await listZones(cf, accountId);
  const active = zones.filter((zone) => !zone.status || zone.status === "active");
  if (active.length === 0) {
    const pending = zones.map((zone) => zone.name);
    throw new ActionRequiredError(
      "add_domain",
      pending.length > 0
        ? `${pending.join(", ")} ${pending.length === 1 ? "isn't" : "aren't"} active yet: finish ${pending.length === 1 ? "its" : "their"} nameserver setup in the Cloudflare dashboard, then run \`everyapp setup\` again.`
        : `Every App needs a domain on Cloudflare, and this account has none. Buy one in the Cloudflare dashboard: Domains → Buy a domain (${registerDomainUrl(accountId)}; a Worker's Domains tab sells them too). Cloudflare Registrar charges what the registry does, about $10 a year for a .com, and the domain is ready in minutes with nothing to configure. Or add a domain you own and point its nameservers at Cloudflare. Then run \`everyapp setup\` again; a subdomain of it works best, e.g. apps.<your domain>.`,
      registerDomainUrl(accountId),
    );
  }
  if (!deps.interactive) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      `Pass --domain with a hostname in one of this account's zones, e.g. --domain apps.${active[0]!.name}. Zones: ${active.map((zone) => zone.name).join(", ")}.`,
    );
  }
  const zone =
    active.length === 1
      ? active[0]!.name
      : await deps.prompts.pickZone(active.map((z) => z.name));
  return normalizeHostname(await deps.prompts.hostname(zone));
}

/**
 * The gateway the checkout builds, live: installed, upgraded, or left as it
 * is when it already runs these sources (told by the install row's tree
 * hash, before anything is built) or this very release. A checkout behind
 * the live release is refused (`git pull`), unless --allow-downgrade.
 */
async function deployOrSkipGateway({
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
}): Promise<D1Database> {
  const gatewayUrl = `https://${target.domain}`;
  // An install that stopped before its first upload isn't live yet.
  const live = install?.liveVersionId ? install : null;
  const allowDowngrade = flags["allow-downgrade"] ?? false;
  const upToDate = (version: string) => {
    out.emit({
      type: "step",
      step: "setup.gateway",
      status: "skip",
      message: `The gateway already runs release ${version}, built from these sources.`,
      data: { release: version, gatewayUrl, upToDate: true },
    });
    return cfD1Database(cf, databaseId!);
  };
  if (live && databaseId) {
    // Before building: a minute or two, for nothing, on a fresh machine.
    const source = await deps.source();
    if (source.treeSha256 && source.treeSha256 === live.sourceTreeSha256) {
      return upToDate(live.releaseVersion);
    }
    if (!allowDowngrade && olderThanInstalled(source, live)) {
      throw downgradeRefused(source, live, { allowDowngradeFlag: true });
    }
  }

  const release = await deps.openRelease();
  try {
    const manifest = release.manifest;
    if (compareVersions(manifest.minCli, deps.cliVersion) > 0) {
      throw new EveryAppError(
        "CLI_TOO_OLD",
        `Gateway release ${manifest.version} needs everyapp ${manifest.minCli} or newer; this is ${deps.cliVersion}.`,
      );
    }
    if (live && databaseId) {
      if (isLiveRelease(release, live)) return upToDate(manifest.version);
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
    return db;
  } finally {
    await release.cleanup();
  }
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
}): Promise<GatewayOwner> {
  const existing = await readOwner(db);
  if (existing) {
    out.emit({
      type: "step",
      step: "setup.owner",
      status: "skip",
      message: `The gateway's owner is ${existing.email}.`,
      data: { ...existing },
    });
    return existing;
  }
  // A CI log is no place for a link that makes whoever opens it the
  // owner: it goes to a person at this terminal, or in the --json events
  // an agent on this machine hands on, as for `gateway deploy`.
  if (
    !maySetupLinkBeShown({
      printSetupLink: flags.printSetupLink,
      terminal: deps.interactive,
      relayed: flags.json,
    })
  ) {
    throw new ActionRequiredError(
      "claim_owner",
      "The gateway has no owner yet. Run `everyapp setup` at a terminal on any machine with this Cloudflare login to create the owner account; apps deploy without one. To have this run print the link into its log instead, pass --printSetupLink.",
    );
  }
  await checkReachable(gatewayUrl, out, deps.seams?.fetch);

  const link = await mintSetupLink({ db, gatewayUrl });
  out.emit({
    type: "action_required",
    action: "claim_owner",
    step: "setup.owner",
    message: `${link.replaced ? "The setup link shown before no longer works; this one replaces it. " : ""}Create the owner account with this one-time setup link (it works once, until ${link.expiresAt.toLocaleString()}; treat it like a password). Waiting for it...`,
    data: {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      waiting: true,
    },
  });
  if (deps.interactive && !flags["no-open"]) await deps.openBrowser(link.url);

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
    return owner;
  }
  if (state.status === "waiting") {
    throw new ActionRequiredError(
      "claim_owner",
      `Nobody has used the setup link yet. It works until ${link.expiresAt.toLocaleString()}: open it, then run \`everyapp setup\` again to finish. (Run before anyone opens it, setup shows a new link, and this one stops working.)`,
      link.url,
    );
  }
  throw new ActionRequiredError(
    "claim_owner",
    "The setup link stopped working before anyone used it: a newer one replaced it (`everyapp gateway claim-link`, or setup on another machine), or it expired. If someone has the newer link, create the owner account with it; otherwise run `everyapp setup` again for a new one.",
  );
}

/**
 * One plain request to the gateway before the owner link goes out, so a
 * certificate still on its way, or Cloudflare Access in front, shows up
 * here rather than on the person's screen. The link is shown either way.
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
      message: `${gatewayUrl} doesn't answer over HTTPS yet (${answer.reason}); its certificate may still be on its way. The setup link works as soon as it does.`,
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
