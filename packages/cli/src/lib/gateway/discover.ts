/**
 * Finding the Gateway, with nothing kept on this machine. A Cloudflare
 * account holds at most one, under fixed resource names (./resources.ts),
 * so every account the login sees is asked for the Gateway's D1 database,
 * all at once, and its install row says where the Gateway serves:
 *
 *   cf auth whoami                         the accounts this login sees
 *   cf d1 list --name every-app-gateway    per account, with that account's
 *                                          CLOUDFLARE_ACCOUNT_ID (otherwise cf
 *                                          uses the one it last used)
 *   _everyapp_install                      URL, base domain, zone
 *
 * An account cf refuses (`auth`) or doesn't know (`not_found`) is asked
 * once more (a 401 from a flaky network looks the same), and then is
 * `unchecked`, never "no Gateway": a CI token scoped to one account must not
 * stop the others from being asked, and an account that couldn't be asked
 * is never offered a second Gateway (`refuseUnchecked`). A network failure
 * is asked once more too, then stops the command.
 *
 * One Gateway: it is the one. Several: --account-id, CLOUDFLARE_ACCOUNT_ID,
 * the host the command names (--gateway, setup's --domain), or a person at
 * the terminal picks; anyone else is asked to (`choose_account`). None: the
 * caller decides (`setup` installs one; anything else fails, listing the
 * accounts asked). `setup` with several accounts (`anyAccount`) never assumes
 * a Gateway in one is where it goes: unless the account or the host is
 * named, the person picks any account the login can ask.
 */
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { isCfError, isNetworkDrop } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { CLI, thisCommand, thisCommandWithout } from "@/lib/output/command";
import { choose } from "@/lib/output/prompt";
import { readInstall, type InstallRecord } from "./install";
import { findGatewayDatabase } from "./resources";

interface CloudflareAccount {
  id: string;
  /** As cf lists it; null for an account it doesn't list. */
  name: string | null;
}

export interface FoundGateway {
  account: CloudflareAccount;
  /** cf, pinned to the Gateway's account. */
  cf: CfRunner;
  databaseId: string;
  /** The Gateway's D1: its registry, install row, leases and ledgers. */
  db: D1Database;
  /** Null until a deploy recorded the install (one that stopped before it could). */
  install: InstallRecord | null;
}

/** An account whose Gateway database couldn't be asked for, twice. */
interface UncheckedAccount extends CloudflareAccount {
  /** What cf said: it refused (`auth`), or doesn't know the account (`not_found`). */
  reason: "auth" | "not_found";
}

export interface Discovery {
  /** Every account asked, in the order cf lists them. */
  probed: CloudflareAccount[];
  /** The accounts that couldn't be asked: whether they have a Gateway is unknown. */
  unchecked: UncheckedAccount[];
  /** Every account that has a Gateway. */
  found: FoundGateway[];
  /** The one this command acts on, or null: none, or none in the account asked for. */
  gateway: FoundGateway | null;
  /** --account-id, else CLOUDFLARE_ACCOUNT_ID. */
  requestedAccountId?: string;
}

interface DiscoverOptions {
  whoami: CfWhoami;
  createCf: (accountId?: string) => CfRunner;
  /** --account-id */
  accountId?: string;
  /** The Gateway's host, when the command names one: it picks among several. */
  host?: string;
  /**
   * The flag that names the Gateway by its host (setup's --domain): the
   * choices among several say it, rather than an account id.
   */
  hostFlag?: string;
  /**
   * setup: a Gateway in one of the login's several accounts isn't taken to
   * be where this run goes; the person picks the account, any of them.
   */
  anyAccount?: boolean;
  interactive: boolean;
  /** Asks the person at the terminal which Gateway (tests answer for them). */
  pick?: (found: FoundGateway[], whoami: CfWhoami) => Promise<FoundGateway>;
  /** Asks the person at the terminal which account, for `anyAccount` (tests answer for them). */
  pickAccount?: (
    accounts: CloudflareAccount[],
    found: FoundGateway[],
    whoami: CfWhoami,
  ) => Promise<CloudflareAccount>;
  /** How long to wait before asking an account again (tests: 0). */
  retryDelayMs?: number;
}

const RETRY_DELAY_MS = 1_000;

export async function discoverGateway({
  whoami,
  createCf,
  accountId,
  host,
  hostFlag,
  anyAccount = false,
  interactive,
  pick = pickAtTerminal,
  pickAccount = pickAccountAtTerminal,
  retryDelayMs = RETRY_DELAY_MS,
}: DiscoverOptions): Promise<Discovery> {
  const requestedAccountId =
    accountId || process.env["CLOUDFLARE_ACCOUNT_ID"] || undefined;
  const listed: CloudflareAccount[] = (whoami.accounts ?? []).map((account) => ({
    id: account.id,
    name: account.name ?? null,
  }));
  // An API token may list no accounts, or not the one it is meant for.
  const probed =
    requestedAccountId && !listed.some((a) => a.id === requestedAccountId)
      ? [...listed, { id: requestedAccountId, name: null }]
      : listed;
  const answers = await Promise.all(probed.map((account) => probe(account, createCf, retryDelayMs)));
  const found = answers.filter((answer): answer is FoundGateway => answer !== null && "db" in answer);
  const unchecked = answers.filter((answer): answer is UncheckedAccount => answer !== null && "reason" in answer);

  const result = { probed, found, unchecked, ...(requestedAccountId ? { requestedAccountId } : {}) };
  if (requestedAccountId) {
    return {
      ...result,
      gateway: found.find((g) => g.account.id === requestedAccountId) ?? null,
    };
  }
  const atHost = host
    ? found.filter((g) => g.install?.gatewayHost.toLowerCase() === host.toLowerCase())
    : [];
  if (atHost.length === 1) return { ...result, gateway: atHost[0]! };

  // An account that couldn't be asked may hold a Gateway already: never offered.
  const candidates = probed.filter((a) => !unchecked.some((u) => u.id === a.id));
  if (anyAccount && found.length > 0 && candidates.length > 1) {
    const chosen = await chooseAccount(candidates, found, whoami, interactive, pickAccount);
    return {
      ...result,
      requestedAccountId: chosen.id,
      gateway: found.find((g) => g.account.id === chosen.id) ?? null,
    };
  }
  if (found.length <= 1) return { ...result, gateway: found[0] ?? null };
  if (interactive) return { ...result, gateway: await pick(found, whoami) };
  // One command per Gateway, ready to run: no single rerun fits.
  throw new ActionRequiredError(
    "choose_account",
    `Choose which Gateway to use\n${whoami.email ?? "This login"} sees a Gateway in ${found.length} Cloudflare accounts. Run one of:`,
    undefined,
    {
      rerun: null,
      data: {
        choices: found.map((gateway) => {
          const gatewayHost = gateway.install?.gatewayHost;
          const byHost = hostFlag && gatewayHost;
          return {
            accountId: gateway.account.id,
            accountName: gateway.account.name,
            gatewayUrl: gatewayHost ? `https://${gatewayHost}` : null,
            label: byHost
              ? (gateway.account.name ?? gateway.account.id)
              : [gateway.account.name, gatewayHost].filter(Boolean).join(" · "),
            rerun: byHost
              ? `${thisCommandWithout(hostFlag)} ${hostFlag} ${gatewayHost}`
              : thisCommand(["--account-id", gateway.account.id]),
          };
        }),
      },
    },
  );
}

/**
 * The account's Gateway; null when this login finds none there; the
 * account, unchecked, when cf refused or didn't know it twice.
 */
async function probe(
  account: CloudflareAccount,
  createCf: (accountId?: string) => CfRunner,
  retryDelayMs: number,
): Promise<FoundGateway | UncheckedAccount | null> {
  const cf = createCf(account.id);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const databaseId = await findGatewayDatabase(cf);
      if (!databaseId) return null;
      const db = cfD1Database(cf, databaseId);
      return { account, cf, databaseId, db, install: await readInstall(db) };
    } catch (error) {
      const reason = isCfError(error, "auth") ? "auth" : isCfError(error, "not_found") ? "not_found" : null;
      if (!reason && !isNetworkDrop(error)) throw error;
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (!reason) throw error;
      return { ...account, reason };
    }
  }
}

/**
 * Before anything is installed because no Gateway was found: refuse when
 * an account couldn't be asked (GATEWAY_CHECK_FAILED), since it may hold
 * the Gateway, and a second one would be installed beside it.
 */
export function refuseUnchecked(discovery: Discovery, whoami: CfWhoami, host?: string): void {
  if (discovery.found.length > 0 || discovery.unchecked.length === 0) return;
  throw checkFailed(discovery, whoami, host);
}

function checkFailed(discovery: Discovery, whoami: CfWhoami, host?: string): EveryAppError {
  const names = discovery.unchecked.map((account) => account.name ?? account.id);
  const answer = discovery.unchecked.every((account) => account.reason === "auth")
    ? "Cloudflare refused to list its databases"
    : "Cloudflare answered that it doesn't know the account";
  const others = discovery.probed.length - discovery.unchecked.length;
  return new EveryAppError(
    "GATEWAY_CHECK_FAILED",
    [
      names.length === 1
        ? `Couldn't check ${names[0]} for a Gateway${host ? ` (looking for ${host})` : ""}`
        : `Couldn't check ${names.length} accounts for a Gateway${host ? ` (looking for ${host})` : ""}: ${names.join(", ")}`,
      `${answer}, twice.${others > 0 ? ` No Gateway in the ${others} other account${others === 1 ? "" : "s"} this login sees.` : ""} Nothing was changed, and no Gateway is installed while one may already exist.`,
      ...(whoami.email ? [`Logged in to Cloudflare as ${whoami.email}.`] : []),
    ].join("\n"),
    {
      retryable: true,
      rerunNote: "in a moment; if it fails again, check this login can read D1 in that account",
      data: { accounts: discovery.probed, unchecked: discovery.unchecked, ...(host ? { host } : {}) },
    },
  );
}

/**
 * The Gateway a command that needs one acts on: discovery's, or
 * GATEWAY_NOT_FOUND, which names the accounts asked and where a Gateway is,
 * if anywhere.
 */
export function requireGateway(
  discovery: Discovery,
  whoami: CfWhoami,
  /** The Gateway's host, when the command names one (--gateway). */
  host?: string,
): FoundGateway {
  if (discovery.gateway) return discovery.gateway;
  const login = whoami.email ? [`Logged in to Cloudflare as ${whoami.email}.`] : [];
  const data = { accounts: discovery.probed, ...(host ? { host } : {}) };
  // Couldn't ask the account the command names, or any with the Gateway: unknown, not "none".
  const requestedUnchecked = discovery.unchecked.some((account) => account.id === discovery.requestedAccountId);
  if (requestedUnchecked || (discovery.found.length === 0 && discovery.unchecked.length > 0)) {
    throw checkFailed(
      requestedUnchecked
        ? { ...discovery, unchecked: discovery.unchecked.filter((account) => account.id === discovery.requestedAccountId) }
        : discovery,
      whoami,
      host,
    );
  }
  if (discovery.requestedAccountId && discovery.found.length > 0) {
    throw new EveryAppError(
      "GATEWAY_NOT_FOUND",
      [
        `Cloudflare account ${discovery.requestedAccountId} has no Gateway`,
        `This login's Gateway${discovery.found.length === 1 ? " is" : "s are"} in ${discovery.found.map(describeGateway).join("; ")}.`,
      ].join("\n"),
      { fix: "pass that account's id to --account-id (or CLOUDFLARE_ACCOUNT_ID), or drop it", data },
    );
  }
  if (discovery.probed.length === 0) {
    throw new EveryAppError(
      "GATEWAY_NOT_FOUND",
      ["This Cloudflare login lists no accounts", ...login].join("\n"),
      { fix: "pass the Gateway's account with --account-id, or set CLOUDFLARE_ACCOUNT_ID", data },
    );
  }
  const accounts = discovery.probed.map((account) => account.name ?? account.id);
  throw new EveryAppError(
    "GATEWAY_NOT_FOUND",
    [
      `No Gateway${host ? ` at ${host}` : ""} in ${accounts.length === 1 ? `${accounts[0]}, the only account this login sees` : `the ${accounts.length} accounts this login sees`}`,
      ...(accounts.length === 1 ? [] : [`${accounts.join(", ")}.`]),
      ...login,
      `Or log in to the Gateway's account: ${CLI} login`,
    ].join("\n"),
    { rerun: `${CLI} setup --domain <hostname>`, rerunNote: "to install one", data },
  );
}

/** `--gateway` and EVERYAPP_GATEWAY_URL must name the Gateway that was found. */
export function checkGatewayUrl(
  gateway: FoundGateway & { install: InstallRecord },
  requested: string | undefined,
  argv: readonly string[] = process.argv.slice(2),
): void {
  if (!requested) return;
  const host = new URL(requested).host.toLowerCase();
  const found = gateway.install.gatewayHost.toLowerCase();
  if (host === found) return;
  const fromFlag = argv.some((arg) => arg === "--gateway" || arg.startsWith("--gateway="));
  const where = gateway.account.name ?? gateway.account.id;
  throw new EveryAppError(
    "GATEWAY_URL_MISMATCH",
    `The Gateway here is ${found}, not ${host}\nFound in ${where}. For ${host}, pass its account with --account-id.`,
    fromFlag
      ? { rerun: thisCommandWithout("--gateway", argv), rerunNote: `to use ${found}` }
      : { fix: `unset EVERYAPP_GATEWAY_URL to use ${found}` },
  );
}

function describeGateway(gateway: FoundGateway): string {
  const account = gateway.account.name ?? gateway.account.id;
  return `${account}${gateway.install ? ` at https://${gateway.install.gatewayHost}` : ""}`;
}

/** `anyAccount`'s choice: the person at the terminal picks, anyone else is asked to (`choose_account`). */
function chooseAccount(
  accounts: CloudflareAccount[],
  found: FoundGateway[],
  whoami: CfWhoami,
  interactive: boolean,
  pickAccount: NonNullable<DiscoverOptions["pickAccount"]>,
): Promise<CloudflareAccount> {
  if (interactive) return pickAccount(accounts, found, whoami);
  // One command per account, ready to run: no single rerun fits.
  throw new ActionRequiredError(
    "choose_account",
    `Choose the Cloudflare account to set up EveryApp in\n${whoami.email ?? "This login"} can use ${accounts.length} accounts, and ${found.map(describeGateway).join("; ")} already has a Gateway. Run one of:`,
    undefined,
    {
      rerun: null,
      data: {
        choices: accounts.map((account) => {
          const gatewayHost = found.find((g) => g.account.id === account.id)?.install?.gatewayHost;
          return {
            accountId: account.id,
            accountName: account.name,
            gatewayUrl: gatewayHost ? `https://${gatewayHost}` : null,
            label: [account.name ?? account.id, gatewayHost].filter(Boolean).join(" · "),
            rerun: thisCommand(["--account-id", account.id]),
          };
        }),
      },
    },
  );
}

/** Ask the person at the terminal which account; a Gateway already in one dim beside it. */
function pickAccountAtTerminal(
  accounts: CloudflareAccount[],
  found: FoundGateway[],
  whoami: CfWhoami,
): Promise<CloudflareAccount> {
  return choose(
    "Which account should EveryApp go in?",
    accounts.map((account) => {
      const gatewayHost = found.find((g) => g.account.id === account.id)?.install?.gatewayHost;
      return {
        label: account.name ?? account.id,
        ...(gatewayHost ? { hint: `Gateway at ${gatewayHost}` } : {}),
        value: account,
      };
    }),
    {
      context: [`${whoami.email ?? "This login"} can use ${accounts.length} Cloudflare accounts`],
    },
  );
}

/** Ask the person at the terminal which Gateway, by its address; its account dim beside it. */
function pickAtTerminal(found: FoundGateway[], whoami: CfWhoami): Promise<FoundGateway> {
  return choose(
    "Which Gateway?",
    found.map((gateway) => {
      const account = gateway.account.name ?? gateway.account.id;
      return gateway.install
        ? { label: gateway.install.gatewayHost, hint: account, value: gateway }
        : { label: account, value: gateway };
    }),
    {
      context: [
        `${whoami.email ?? "This login"} sees a Gateway in ${found.length} Cloudflare accounts`,
      ],
    },
  );
}
