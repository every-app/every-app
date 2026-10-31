/**
 * Finding the Gateway, with nothing kept on this machine but which one a
 * person picked (./pick.ts). A Cloudflare
 * account may hold several Gateways, each under its own names
 * (./resources.ts, packages/perimeter manifest/gatewayNames.ts: the
 * default `every-app-gateway`, and `every-app-gateway-<name>` for a named
 * one), so every account the login sees is asked for its Gateway
 * databases, all at once, and each install row says where that Gateway
 * serves:
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
 * One Gateway: it is the one. Several (in one account or across accounts):
 * the Gateway the command names (--gateway, by host or by name; setup's
 * --domain and --name), --account-id or CLOUDFLARE_ACCOUNT_ID when that
 * narrows it to one, or a person at the terminal picks; anyone else is
 * asked to (`choose_account`, one rerun per Gateway), never guessed for. None: the caller decides
 * (`setup` installs one; anything else fails, listing the accounts asked).
 * A person's pick holds for the rest of the run, and is remembered for the
 * checkout (./pick.ts): a later command there at a terminal takes it with a
 * dim line, unless it asks anyway (`alwaysAsk`). --json and unattended runs
 * never read it, so they still need --gateway when there are several.
 * `setup` with several accounts (`anyAccount`) never assumes a Gateway in
 * one is where it goes: unless the account or the host is named, the
 * person picks any account the login can ask. `setup` looks for one
 * Gateway name only (`name`: the default's unless --name says): a named
 * Gateway beside the default is never mistaken for it.
 */
import { gatewayNames, type GatewayNames } from "@every-app/perimeter/manifest";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { isCfError, isNetworkDrop } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { CLI, thisCommand, thisCommandWithout } from "@/lib/output/command";
import { choose, tellPerson } from "@/lib/output/prompt";
import chalk from "chalk";
import { readInstall, type InstallRecord } from "./install";
import { listGatewayDatabases } from "./resources";
import { checkoutPick, pickedAmong, rememberPick, thisRunsPick } from "./pick";

interface CloudflareAccount {
  id: string;
  /** As cf lists it; null for an account it doesn't list. */
  name: string | null;
}

export interface FoundGateway {
  account: CloudflareAccount;
  /** cf, pinned to the Gateway's account. */
  cf: CfRunner;
  /** The Gateway's names: its Worker, D1, KV, queue, and what its apps are called. */
  names: GatewayNames;
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
  /** Every Gateway found, in the order cf lists the accounts, the default's first in each. */
  found: FoundGateway[];
  /** Gateways of other names than `onlyName`, when setup looked for one name only. */
  others: FoundGateway[];
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
   * The Gateway's name, when the command names one (--gateway <name>): it
   * picks among several. Null is the default Gateway by name.
   */
  name?: string | null;
  /**
   * setup: only Gateways of this name count (null: the default's), so a
   * named Gateway beside the default is never taken for it, and nothing is
   * installed beside a Gateway of the same name. Others in the account are
   * `others`, for the messages.
   */
  onlyName?: string | null;
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
  /**
   * The checkout's remembered Gateway is only preselected, never taken
   * without asking: commands that destroy or replace something.
   */
  alwaysAsk?: boolean;
  /** Asks the person at the terminal which Gateway, `initial` preselected (tests answer for them). */
  pick?: (found: FoundGateway[], whoami: CfWhoami, initial?: FoundGateway) => Promise<FoundGateway>;
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

export async function discoverGateway(options: DiscoverOptions): Promise<Discovery> {
  const discovery = await discover(options);
  // Named by --gateway among several, at a terminal: the checkout's pick from now on.
  const named = options.host !== undefined || options.name !== undefined;
  if (options.interactive && named && discovery.gateway && discovery.found.length > 1) {
    await rememberPick(discovery.gateway);
  }
  return discovery;
}

async function discover({
  whoami,
  createCf,
  accountId,
  host,
  hostFlag,
  name,
  onlyName,
  anyAccount = false,
  interactive,
  alwaysAsk = false,
  pick: askPerson = pickAtTerminal,
  pickAccount = pickAccountAtTerminal,
  retryDelayMs = RETRY_DELAY_MS,
}: DiscoverOptions): Promise<Discovery> {
  const pick = (candidates: FoundGateway[], whoami: CfWhoami) =>
    pickOnce(candidates, whoami, { alwaysAsk, askPerson });
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
  const everyFound = answers.flatMap((answer) => (Array.isArray(answer) ? answer : []));
  const unchecked = answers.filter((answer): answer is UncheckedAccount => !Array.isArray(answer) && answer !== null);
  const wanted = onlyName === undefined ? null : gatewayNames(onlyName).name;
  const found = onlyName === undefined ? everyFound : everyFound.filter((g) => g.names.name === wanted);
  const others = onlyName === undefined ? [] : everyFound.filter((g) => g.names.name !== wanted);

  const result = { probed, found, others, unchecked, ...(requestedAccountId ? { requestedAccountId } : {}) };
  // The command names the Gateway: by host, or by name.
  const atHost = host
    ? found.filter((g) => g.install?.gatewayHost.toLowerCase() === host.toLowerCase())
    : [];
  if (atHost.length === 1) return { ...result, gateway: atHost[0]! };
  if (host !== undefined && found.length > 1) {
    if (atHost.length > 1) {
      if (interactive) return { ...result, gateway: await pick(atHost, whoami) };
      throw chooseGateway(atHost, whoami, hostFlag);
    }
    return { ...result, gateway: null };
  }
  const byName = name === undefined ? [] : found.filter((g) => g.names.name === gatewayNames(name).name);
  if (requestedAccountId) {
    const inAccount = (name === undefined ? found : byName).filter((g) => g.account.id === requestedAccountId);
    if (inAccount.length <= 1) return { ...result, gateway: inAccount[0] ?? null };
    // Several of them in the account asked for: the person picks, or is told how.
    if (interactive) return { ...result, gateway: await pick(inAccount, whoami) };
    throw chooseGateway(inAccount, whoami, hostFlag);
  }
  if (name !== undefined) {
    if (byName.length <= 1) return { ...result, gateway: byName[0] ?? null };
    if (interactive) return { ...result, gateway: await pick(byName, whoami) };
    throw chooseGateway(byName, whoami, hostFlag);
  }

  // An account that couldn't be asked may hold a Gateway already: never offered.
  const candidates = probed.filter((a) => !unchecked.some((u) => u.id === a.id));
  if (anyAccount && found.length > 0 && candidates.length > 1) {
    const chosen = await chooseAccount(candidates, found, whoami, interactive, pickAccount);
    const inAccount = found.filter((g) => g.account.id === chosen.id);
    if (inAccount.length > 1) {
      if (interactive) return { ...result, requestedAccountId: chosen.id, gateway: await pick(inAccount, whoami) };
      throw chooseGateway(inAccount, whoami, hostFlag);
    }
    return { ...result, requestedAccountId: chosen.id, gateway: inAccount[0] ?? null };
  }
  if (found.length <= 1) return { ...result, gateway: found[0] ?? null };
  if (interactive) return { ...result, gateway: await pick(found, whoami) };
  throw chooseGateway(found, whoami, hostFlag);
}

/**
 * Several Gateways and nothing to pick one by: one command per Gateway,
 * ready to run (no single rerun fits). By host (the flag the command
 * names it with, --gateway or setup's --domain) when the Gateway has one,
 * else by account and name.
 */
function chooseGateway(found: FoundGateway[], whoami: CfWhoami, hostFlag?: string): ActionRequiredError {
  const accounts = new Set(found.map((gateway) => gateway.account.id));
  return new ActionRequiredError(
    "choose_account",
    `Choose which Gateway to use\n${whoami.email ?? "This login"} sees ${
      accounts.size === found.length
        ? `a Gateway in ${found.length} Cloudflare accounts`
        : `${found.length} Gateways in ${accounts.size === 1 ? (found[0]!.account.name ?? found[0]!.account.id) : `${accounts.size} Cloudflare accounts`}`
    }. Run one of:`,
    undefined,
    {
      rerun: null,
      data: {
        choices: found.map((gateway) => {
          const gatewayHost = gateway.install?.gatewayHost;
          const account = gateway.account.name ?? gateway.account.id;
          // setup names a Gateway by its address (--domain): the account alone is the label.
          const byHost = hostFlag !== undefined && gatewayHost;
          // Two in one account: the account id alone doesn't pick one; its URL (or name) does.
          const sameAccount = found.some((other) => other !== gateway && other.account.id === gateway.account.id);
          return {
            accountId: gateway.account.id,
            accountName: gateway.account.name,
            gatewayName: gateway.names.name,
            gatewayWorker: gateway.names.worker,
            gatewayUrl: gatewayHost ? `https://${gatewayHost}` : null,
            label: byHost ? account : [account, gatewayHost ?? gateway.names.worker].join(" · "),
            rerun: byHost
              ? `${thisCommandWithout(hostFlag)} ${hostFlag} ${gatewayHost}`
              : sameAccount
                ? thisCommand([
                    "--account-id",
                    gateway.account.id,
                    "--gateway",
                    gatewayHost ? `https://${gatewayHost}` : gateway.names.worker,
                  ])
                : thisCommand(["--account-id", gateway.account.id]),
          };
        }),
      },
    },
  );
}

/**
 * The account's Gateways (an empty list when this login finds none there;
 * never null); the account, unchecked, when cf refused or didn't know it
 * twice.
 */
async function probe(
  account: CloudflareAccount,
  createCf: (accountId?: string) => CfRunner,
  retryDelayMs: number,
): Promise<FoundGateway[] | UncheckedAccount | null> {
  const cf = createCf(account.id);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const databases = await listGatewayDatabases(cf);
      return await Promise.all(
        databases.map(async ({ id: databaseId, names }) => {
          const db = cfD1Database(cf, databaseId);
          return { account, cf, names, databaseId, db, install: await readInstall(db) };
        }),
      );
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
  const named = gateway.names.name ? ` (${gateway.names.worker})` : "";
  return `${account}${gateway.install ? ` at https://${gateway.install.gatewayHost}` : ""}${named}`;
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
          const hosts = found
            .filter((g) => g.account.id === account.id)
            .map((g) => g.install?.gatewayHost ?? g.names.worker);
          return {
            accountId: account.id,
            accountName: account.name,
            gatewayUrl: hosts[0] && hosts[0].includes(".") ? `https://${hosts[0]}` : null,
            label: [account.name ?? account.id, ...hosts].join(" · "),
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
      const hosts = found
        .filter((g) => g.account.id === account.id)
        .map((g) => g.install?.gatewayHost ?? g.names.worker);
      return {
        label: account.name ?? account.id,
        ...(hosts.length > 0 ? { hint: `Gateway at ${hosts.join(", ")}` } : {}),
        value: account,
      };
    }),
    {
      context: [`${whoami.email ?? "This login"} can use ${accounts.length} Cloudflare accounts`],
    },
  );
}

/** Ask the person at the terminal which Gateway, by its address; its account dim beside it; `initial` preselected. */
function pickAtTerminal(found: FoundGateway[], whoami: CfWhoami, initial?: FoundGateway): Promise<FoundGateway> {
  return choose(
    "Which Gateway?",
    found.map((gateway) => {
      const account = gateway.account.name ?? gateway.account.id;
      const hint = gateway.names.name ? `${account} · ${gateway.names.worker}` : account;
      return gateway.install
        ? { label: gateway.install.gatewayHost, hint, value: gateway }
        : { label: gateway.names.worker, hint: account, value: gateway };
    }),
    {
      context: [`${whoami.email ?? "This login"} sees ${found.length} Gateways`],
      ...(initial ? { initial } : {}),
    },
  );
}

/**
 * A person picks among `candidates` once a run: this run's pick again
 * without asking; else the checkout's, with a dim line (`alwaysAsk`: only
 * preselected); else asked. The answer is this run's pick and the
 * checkout's.
 */
async function pickOnce(
  candidates: FoundGateway[],
  whoami: CfWhoami,
  { alwaysAsk, askPerson }: { alwaysAsk: boolean; askPerson: NonNullable<DiscoverOptions["pick"]> },
): Promise<FoundGateway> {
  const again = pickedAmong(candidates, thisRunsPick());
  if (again) return again;
  const remembered = pickedAmong(candidates, await checkoutPick());
  if (remembered && !alwaysAsk) {
    tellPerson(chalk.dim(`Using ${gatewayLabel(remembered)} (pick another with --gateway)`));
    await rememberPick(remembered);
    return remembered;
  }
  const chosen = await askPerson(candidates, whoami, remembered ?? undefined);
  await rememberPick(chosen);
  return chosen;
}

/** A Gateway as a person knows it: its host, else its Worker. */
function gatewayLabel(gateway: FoundGateway): string {
  return gateway.install?.gatewayHost ?? gateway.names.worker;
}
