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
 * An account cf refuses (`auth`) or doesn't know (`not_found`) has no
 * Gateway as far as this login goes: a CI token scoped to one account must
 * not stop the others from being asked.
 *
 * One Gateway: it is the one. Several: --account-id, CLOUDFLARE_ACCOUNT_ID,
 * the host the command names (--gateway, setup's --domain), or a person at
 * the terminal picks; anyone else is asked to (`choose_account`). None: the
 * caller decides (`setup` installs one; anything else fails, listing the
 * accounts asked).
 */
import chalk from "chalk";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { isCfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { CLI, thisCommand, thisCommandWithout } from "@/lib/output/command";
import { choose, tellPerson } from "@/lib/output/prompt";
import { formatTable } from "@/lib/output/table";
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

export interface Discovery {
  /** Every account asked, in the order cf lists them. */
  probed: CloudflareAccount[];
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
  interactive: boolean;
  /** Asks the person at the terminal which Gateway (tests answer for them). */
  pick?: (found: FoundGateway[]) => Promise<FoundGateway>;
}

export async function discoverGateway({
  whoami,
  createCf,
  accountId,
  host,
  interactive,
  pick = pickAtTerminal,
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
  const found = (
    await Promise.all(probed.map((account) => probe(account, createCf)))
  ).filter((gateway): gateway is FoundGateway => gateway !== null);

  const result = { probed, found, ...(requestedAccountId ? { requestedAccountId } : {}) };
  if (requestedAccountId) {
    return {
      ...result,
      gateway: found.find((g) => g.account.id === requestedAccountId) ?? null,
    };
  }
  if (found.length <= 1) return { ...result, gateway: found[0] ?? null };

  const atHost = host
    ? found.filter((g) => g.install?.gatewayHost.toLowerCase() === host.toLowerCase())
    : [];
  if (atHost.length === 1) return { ...result, gateway: atHost[0]! };
  if (interactive) return { ...result, gateway: await pick(found) };
  throw new ActionRequiredError(
    "choose_account",
    [
      `This login sees a Gateway in ${found.length} Cloudflare accounts; pick one`,
      ...formatTable(
        ["ACCOUNT", "ID", "GATEWAY"],
        found.map((gateway) => [
          gateway.account.name ?? "(unnamed)",
          gateway.account.id,
          gateway.install ? `https://${gateway.install.gatewayHost}` : "(not installed)",
        ]),
      ),
    ].join("\n"),
    undefined,
    {
      rerun: `${thisCommand()} --account-id <id>`,
      data: {
        choices: found.map((gateway) => ({
          accountId: gateway.account.id,
          accountName: gateway.account.name,
          gatewayUrl: gateway.install ? `https://${gateway.install.gatewayHost}` : null,
          rerun: `${thisCommand()} --account-id ${gateway.account.id}`,
        })),
      },
    },
  );
}

/** The account's Gateway, or null when this login finds none there. */
async function probe(
  account: CloudflareAccount,
  createCf: (accountId?: string) => CfRunner,
): Promise<FoundGateway | null> {
  const cf = createCf(account.id);
  try {
    const databaseId = await findGatewayDatabase(cf);
    if (!databaseId) return null;
    const db = cfD1Database(cf, databaseId);
    return { account, cf, databaseId, db, install: await readInstall(db) };
  } catch (error) {
    if (isCfError(error, "auth") || isCfError(error, "not_found")) {
      return null;
    }
    throw error;
  }
}

/**
 * The Gateway a command that needs one acts on: discovery's, or
 * GATEWAY_NOT_FOUND, which names the accounts asked and where a Gateway is,
 * if anywhere.
 */
export function requireGateway(
  discovery: Discovery,
  whoami: CfWhoami,
): FoundGateway {
  if (discovery.gateway) return discovery.gateway;
  const login = whoami.email ? [`Logged in to Cloudflare as ${whoami.email}.`] : [];
  const data = { accounts: discovery.probed };
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
      accounts.length === 1
        ? `No Gateway in ${accounts[0]}, the only account this login sees`
        : `No Gateway in the ${accounts.length} accounts this login sees`,
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

/** Ask the person at the terminal which account's Gateway; the answer names the account. */
async function pickAtTerminal(found: FoundGateway[]): Promise<FoundGateway> {
  const gateway = await choose(
    "Which account?",
    found.map((gateway) => ({
      label: gateway.account.name ?? gateway.account.id,
      ...(gateway.install ? { hint: `https://${gateway.install.gatewayHost}` } : {}),
      value: gateway,
    })),
    { context: [`This login sees a Gateway in ${found.length} Cloudflare accounts.`] },
  );
  tellPerson(chalk.dim(`Skip this next time with --account-id ${gateway.account.id}`));
  return gateway;
}
