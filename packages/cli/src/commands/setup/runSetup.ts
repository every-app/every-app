/**
 * `everyapp setup`: from an empty Cloudflare account to a working gateway,
 * its owner, and this CLI logged in, in one command. Apps are deployed
 * from the repository afterwards (`pnpm run deploy` in apps/<app>).
 *
 * Every step looks at what is there first and acts only on what is
 * missing, so running setup again picks up where it stopped (a login to
 * approve, a domain to buy, a link nobody opened yet), and does nothing
 * once everything is there:
 *
 *    toolchain   Node and cf
 *    auth        cf logged in: `cf auth login` at a terminal, cf's device
 *                link and code under --json, or CLOUDFLARE_API_TOKEN
 *    account     which Cloudflare account
 *    plan        Workers Paid: warned about, never required
 *    domain      where the gateway lives: --domain, the install's, or a
 *                zone picked at the terminal (apps.<zone>)
 *    gateway     deployed, or upgraded to this CLI's release
 *    owner       a one-time setup link, opened in the browser (never put
 *                into a CI log, unless --printSetupLink)
 *    login       the owner's first deploy token, handed to this CLI once
 *                the link is claimed (lib/gateway/autoLogin.ts)
 *    extras      what can be set up next (AI, email)
 *
 * With --json, each step is an NDJSON event and what only a person can do
 * is `action_required`; a run that stops on one exits 2, and running the
 * same command again resumes it.
 */
import {
  deployGatewayRelease,
  findInstall,
  gatewayTarget,
} from "@/commands/gateway/deploy/deployGateway";
import { rememberedInstall } from "@/commands/gateway/shared";
import { ensureCfAuth, resolveAccount } from "@/lib/cf/account";
import { PINNED_CF_VERSION } from "@/lib/cf/bin";
import { syncAppToolsWithGateway } from "@/commands/app/deploy/steps/syncTools";
import { syncGatewayAppTools } from "@/commands/gateway/deploy/steps/syncAppTools";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { hasWorkersPaid } from "@/lib/cf/plan";
import type { CfRunner } from "@/lib/cf/runner";
import type { CaaLookup } from "@/lib/domains/caa";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { listZones, registerDomainUrl } from "@/lib/domains/zones";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import {
  explainGatewayError,
  GatewayApiError,
  type GatewayClient,
  type GatewayStatusResponse,
} from "@/lib/gateway/api";
import { olderThanInstalled } from "@/lib/gateway/apply";
import {
  checkSetupLink,
  describeOwnerLogin,
  setupLinkGone,
  waitForOwnerLogin,
} from "@/lib/gateway/autoLogin";
import { readGatewayCredential } from "@/lib/gateway/credentials";
import type { InstallRecord } from "@/lib/gateway/install";
import {
  readPendingClaim,
  type PendingClaim,
} from "@/lib/gateway/pendingClaims";
import { compareVersions, type GatewayRelease } from "@/lib/gateway/release";
import {
  gatewayHasOwner,
  maySetupLinkBeShown,
  mintOperatorSetupLink,
} from "@/lib/gateway/setup-link";
import type { EventSink } from "@/lib/output/events";

export interface SetupFlags {
  domain?: string;
  "account-id"?: string;
  "allow-free-plan"?: boolean;
  "force-dns"?: boolean;
  "no-open"?: boolean;
  /** Show the owner setup link in CI or piped output too (`gateway deploy`'s flag). */
  printSetupLink?: boolean;
  json?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

/** What only a person at a terminal answers. */
interface SetupPrompts {
  confirm(message: string): Promise<boolean>;
  pickZone(zones: string[]): Promise<string>;
  hostname(zone: string): Promise<string>;
}

/** Everything setup reaches outside itself; tests swap in fakes. */
export interface SetupDeps {
  createCf: (accountId?: string) => CfRunner;
  gatewayClient: (gatewayUrl: string) => GatewayClient;
  openRelease: () => Promise<GatewayRelease>;
  /** A person is at this terminal, and this isn't a --json run. */
  interactive: boolean;
  prompts: SetupPrompts;
  openBrowser: (url: string) => Promise<void>;
  cliVersion: string;
  /** Seams for the deploys' waits and lookups (tests). */
  seams?: {
    readStatus?: (gatewayUrl: string) => Promise<GatewayStatusResponse>;
    sleep?: (ms: number) => Promise<void>;
    verifyTimeoutMs?: number;
    leaseWaitMs?: number;
    lookupCaa?: CaaLookup;
    certificates?: {
      isReady?: (url: string) => Promise<boolean>;
      sleep?: (ms: number) => Promise<void>;
      maxWaitMs?: number;
    };
    login?: {
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
    onDeviceLogin: flags.json
      ? (login) =>
          out.emit({
            type: "action_required",
            action: "cloudflare_login",
            step: "setup.auth",
            message:
              "Log in to Cloudflare: open the link and enter the code (waiting for it).",
            data: { url: login.url, code: login.code, waiting: true },
          })
      : undefined,
  });
  out.emit({
    type: "step",
    step: "setup.auth",
    status: "ok",
    message: `Logged in to Cloudflare${whoami.email ? ` as ${whoami.email}` : ""}.`,
    data: { email: whoami.email ?? null },
  });
  const requestedDomain = normalizeHostname(flags.domain);
  // The account this machine set the gateway up in before, for a re-run.
  const cached = await rememberedInstall(requestedDomain);
  const account = await resolveAccount({
    whoami,
    flag: flags["account-id"],
    remembered: cached?.accountId,
    interactive: deps.interactive,
  });
  const cf = deps.createCf(account.id);
  out.emit({
    type: "step",
    step: "setup.account",
    status: "ok",
    message: `Using Cloudflare account ${account.name ?? account.id}.`,
    data: { id: account.id, name: account.name },
  });
  await checkPlan(cf, account.id, flags, out, deps);

  // Where the gateway lives.
  const { databaseId, install } = await findInstall(cf);
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
    message:
      target.routing === "custom-domains"
        ? `The gateway lives at https://${target.domain}, each app one label below it (todo.${target.appBaseDomain}) as its own Custom Domain.`
        : `The gateway lives at https://${target.domain}, its apps at <app>-<org>.${target.domain} through its wildcard route (\`everyapp gateway use-per-app-domains\` changes that).`,
    data: {
      gatewayHost: target.domain,
      appBaseDomain: target.appBaseDomain,
      zone: target.zone.name,
      routing: target.routing,
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

  // Its owner, and this CLI's login.
  const claim = await ensureOwnerLink({ db, gatewayUrl, flags, out, deps });
  const login = await ensureLogin({ db, gatewayUrl, claim, out, deps });

  out.emit({
    type: "step",
    step: "setup.extras",
    status: "skip",
    message:
      "Optional, any time: AI for apps (`everyapp gateway secret set OPENAI_API_KEY`), and email for invitations and password resets (onboard the domain for Cloudflare Email Sending, then `everyapp gateway secret set EMAIL_FROM`); until then invitations and resets are links to share.",
  });
  return { gatewayUrl, organizationName: login };
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
 * 10 ms of CPU; an account has 10 databases. Warned about, never required:
 * the subscription's shape isn't verified, so a paid account could read
 * as unknown.
 */
async function checkPlan(
  cf: CfRunner,
  accountId: string,
  flags: SetupFlags,
  out: EventSink,
  deps: SetupDeps,
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
  if (deps.interactive && !flags.yes) {
    if (!(await deps.prompts.confirm("Continue without confirming Workers Paid?"))) {
      throw new ActionRequiredError(
        "upgrade_workers_paid",
        "Subscribe to Workers Paid, then run `everyapp setup` again.",
        url,
      );
    }
  }
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
  const release = await deps.openRelease();
  try {
    const manifest = release.manifest;
    if (compareVersions(manifest.minCli, deps.cliVersion) > 0) {
      throw new EveryAppError(
        "CLI_TOO_OLD",
        `Gateway release ${manifest.version} needs everyapp ${manifest.minCli} or newer; this is ${deps.cliVersion}.`,
      );
    }
    if (install && databaseId) {
      const skip =
        install.releaseSha256 === manifest.sha256
          ? `The gateway already runs release ${manifest.version}.`
          : olderThanInstalled(manifest, install)
            ? `The gateway runs release ${install.releaseVersion}, newer than the ${manifest.version} built from this checkout; leaving it as it is.`
            : null;
      if (skip) {
        out.emit({ type: "step", step: "setup.gateway", status: "skip", message: skip });
        return cfD1Database(cf, databaseId);
      }
    }
    if (
      !install &&
      deps.interactive &&
      !flags.yes &&
      !(await deps.prompts.confirm(
        `Install the Every App gateway at https://${target.domain} in ${account.name ?? account.id}?`,
      ))
    ) {
      throw new EveryAppError("SETUP_CANCELLED", "Nothing was installed.");
    }
    out.emit({
      type: "step",
      step: "setup.gateway",
      status: "start",
      message: install
        ? `Upgrading the gateway to release ${manifest.version}...`
        : `Installing the gateway at https://${target.domain}...`,
    });
    const { result, db } = await deployGatewayRelease({
      cf,
      out,
      reason: install ? "upgrade" : "deploy",
      release,
      accountId: account.id,
      target,
      interactive: deps.interactive,
      forceDns: flags["force-dns"],
      readStatus: deps.seams?.readStatus,
      sleep: deps.seams?.sleep,
      verifyTimeoutMs: deps.seams?.verifyTimeoutMs,
      leaseWaitMs: deps.seams?.leaseWaitMs,
      lookupCaa: deps.seams?.lookupCaa,
      certificates: deps.seams?.certificates,
    });
    out.emit({
      type: "step",
      step: "setup.gateway",
      status: "ok",
      message: `Gateway ${manifest.version} is live at https://${target.domain}.`,
      data: { versionId: result.versionId, release: manifest.version },
    });
    if (install) {
      // An upgrade: each app's tools catalog, taken by this gateway version,
      // as `gateway upgrade` does. A new install has no apps yet.
      const gatewayUrl = `https://${target.domain}`;
      await syncGatewayAppTools({
        gatewayUrl,
        db,
        out,
        verbose: flags.verbose ?? false,
        boundWorkers: result.appWorkers,
        syncApp: (options) =>
          syncAppToolsWithGateway({
            ...options,
            client: deps.gatewayClient(gatewayUrl),
          }),
      });
    }
    return db;
  } finally {
    await release.cleanup();
  }
}

/**
 * A gateway with no owner gets a setup link: the one minted before while
 * the gateway still waits on it (a resumed setup), else a new one with a
 * secret only this CLI keeps. Returns the pending claim, if any.
 */
async function ensureOwnerLink({
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
}): Promise<PendingClaim | null> {
  const host = new URL(gatewayUrl).host;
  if (await gatewayHasOwner(db)) {
    out.emit({
      type: "step",
      step: "setup.owner",
      status: "skip",
      message: "The gateway has its owner.",
    });
    return readPendingClaim(host);
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
      "The gateway has no owner yet. Create the owner account from your own machine: run `everyapp setup` (or `everyapp gateway claim-link`) in a terminal. To have this run print the link into its log instead, pass --printSetupLink.",
    );
  }
  // The link an interrupted setup showed, if the gateway still waits on it:
  // a newer link (`gateway claim-link`, a setup elsewhere) replaces it,
  // and links expire. If it can't be reached to say, the link is shown.
  let pending = await readPendingClaim(host);
  let replacing = false;
  if (pending) {
    const state = await checkSetupLink({
      claim: pending,
      client: deps.gatewayClient(gatewayUrl),
    });
    if (state.status === "logged_in") {
      out.emit({
        type: "step",
        step: "setup.owner",
        status: "ok",
        message: "The owner account was just created with the setup link.",
      });
      return null;
    }
    if (state.status === "gone") {
      pending = null;
      replacing = true;
    }
  }
  const link = pending
    ? { url: pending.url, expiresAt: pending.expiresAt }
    : await mintOperatorSetupLink({ db, gatewayUrl }).then((minted) => ({
        url: minted.url,
        expiresAt: minted.expiresAt.toISOString(),
      }));
  out.emit({
    type: "action_required",
    action: "claim_owner",
    step: "setup.owner",
    message: `${replacing ? "The setup link shown before stopped working before anyone used it (a newer one replaced it, or it expired), so here is a new one. " : ""}Create the owner account with this one-time setup link (it works once, until ${new Date(link.expiresAt).toLocaleString()}; treat it like a password). Waiting for it...`,
    data: { url: link.url, expiresAt: link.expiresAt, waiting: true },
  });
  if (deps.interactive && !flags["no-open"]) await deps.openBrowser(link.url);
  return pending ?? (await readPendingClaim(host));
}

/**
 * Log this CLI in to the gateway: a deploy token it already has, or the
 * one the gateway hands over for the claimed link. Returns the
 * organization's name.
 */
async function ensureLogin({
  db,
  gatewayUrl,
  claim,
  out,
  deps,
}: {
  db: D1Database;
  gatewayUrl: string;
  claim: PendingClaim | null;
  out: EventSink;
  deps: SetupDeps;
}): Promise<string | null> {
  const client = deps.gatewayClient(gatewayUrl);
  if (await readGatewayCredential(gatewayUrl)) {
    const whoami = await client.whoami().catch((error: unknown) => {
      // A token the gateway refuses (revoked, or another gateway's) means
      // logging in again; anything else, that it isn't reachable yet.
      if (error instanceof GatewayApiError && [401, 403].includes(error.status)) {
        return null;
      }
      throw new EveryAppError(
        "GATEWAY_UNREACHABLE",
        `Couldn't reach ${gatewayUrl} (${error instanceof Error ? error.message : String(error)}); its certificate may still be on its way. Run \`everyapp setup\` again in a few minutes.`,
        { retryable: true },
      );
    });
    if (whoami) {
      out.emit({
        type: "step",
        step: "setup.login",
        status: "skip",
        message: `Logged in to ${gatewayUrl} for ${whoami.organizationName}.`,
      });
      return whoami.organizationName;
    }
  }
  if (!claim) {
    throw new ActionRequiredError(
      "create_deploy_token",
      `The gateway has an owner, but this machine has no deploy token for it. Sign in at ${gatewayUrl}, create one under Admin → Tokens, run \`everyapp login\`, then \`everyapp setup\` again.`,
      `${gatewayUrl}/admin/tokens`,
    );
  }
  const state = await waitForOwnerLogin({
    claim,
    client,
    ...deps.seams?.login,
  }).catch((error: unknown) => {
    // Cloudflare Access put in front meanwhile: say so, by its code.
    throw explainGatewayError(error);
  });
  if (state.status === "gone") {
    // Not minted again here: a link that dies while it is waited on was
    // most likely replaced by whoever wants to use the newer one.
    throw setupLinkGone(gatewayUrl, await gatewayHasOwner(db));
  }
  if (state.status === "waiting") {
    throw new ActionRequiredError(
      "claim_owner",
      `Nobody has finished the setup link yet. It works until ${new Date(claim.expiresAt).toLocaleString()}: open it, then run \`everyapp setup\` again (or \`everyapp login --resume\`).`,
      claim.url,
    );
  }
  // Who claimed the link, so a person can tell it was who they expected.
  const { login } = state;
  out.emit({
    type: "step",
    step: "setup.login",
    status: "ok",
    message: describeOwnerLogin(gatewayUrl, login),
    data: {
      organizationId: login.organizationId,
      organizationName: login.organizationName,
      ownerEmail: login.ownerEmail,
    },
  });
  return login.organizationName;
}
