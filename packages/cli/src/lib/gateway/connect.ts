/**
 * The Gateway a command acts on, reached the one way there is in
 * self-host: the operator's Cloudflare login (or CLOUDFLARE_API_TOKEN), the
 * Gateway's D1 database in one of the login's accounts, and its install row
 * (./discover.ts). Nothing is asked of the Gateway over HTTPS, and nothing
 * is kept on this machine.
 *
 * `--gateway` and EVERYAPP_GATEWAY_URL (meant for the hosted tier) only
 * pick among several Gateways here; the URL itself always comes from the
 * install row, and one that names another host is refused.
 */
import { gatewayNameProblem, type GatewayNames } from "@every-app/perimeter/manifest";
import { deviceLoginAction, ensureCfAuth } from "@/lib/cf/account";
import type { D1Database } from "@/lib/cf/d1";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import {
  checkGatewayUrl,
  discoverGateway,
  requireGateway,
  type Discovery,
  type FoundGateway,
} from "./discover";
import { notDeployedByEveryapp, type InstallRecord } from "./install";
import { deployerFor, type Deployer } from "./registry";

interface GatewayConnection {
  /** cf, pinned to the Gateway's account. */
  cf: CfRunner;
  accountId: string;
  /** The account's name, when cf lists it. */
  accountName: string | null;
  databaseId: string;
  /** The Gateway's names: its Worker, D1, KV, queue, and what its apps are called. */
  names: GatewayNames;
  /** The Gateway's D1: its registry, install row, leases and ledgers. */
  db: D1Database;
  install: InstallRecord;
  gatewayUrl: string;
  /** Who acts: the Cloudflare login's email, or the account's API token. */
  deployer: Deployer;
}

/** cf for an account, or for no account in particular (`cf auth whoami`). */
type CreateCf = (accountId?: string) => CfRunner;

const defaultCreateCf: CreateCf = (accountId) => createCfRunner({ accountId });

/**
 * A gateway URL as `--gateway` takes it: no path, query or trailing slash.
 * `source` names where it came from, for the error.
 */
function normalizeGatewayUrl(gatewayUrl: string, source: "--gateway" | "EVERYAPP_GATEWAY_URL"): string {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new EveryAppError(
      "INVALID_GATEWAY_URL",
      source === "--gateway"
        ? `--gateway must be a full URL, not "${gatewayUrl}"\nFor example https://apps.example.com.`
        : `EVERYAPP_GATEWAY_URL must be a full URL, not "${gatewayUrl}"`,
      source === "--gateway"
        ? {}
        : { fix: `set it to https://${gatewayUrl.replace(/^\w+:\/\//, "")}, or unset it` },
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * What `--gateway` or EVERYAPP_GATEWAY_URL names, if either does: the
 * Gateway's URL, or (`--gateway` only) its name, `every-app-gateway-<name>`
 * or the bare name, when the account holds several (`isGatewayName`).
 */
export function requestedGatewayUrl(flag?: string): string | undefined {
  if (flag) return isGatewayName(flag) ? gatewayNameFrom(flag) : normalizeGatewayUrl(flag, "--gateway");
  const fromEnv = process.env["EVERYAPP_GATEWAY_URL"];
  return fromEnv ? normalizeGatewayUrl(fromEnv, "EVERYAPP_GATEWAY_URL") : undefined;
}

/** A `--gateway` value that is a name, not a URL: no scheme and no dot. */
function isGatewayName(value: string): boolean {
  return !value.includes("://") && !value.includes(".") && !value.includes("/");
}

/** The name `--gateway` gives: `demo`, `every-app-gateway-demo` or `every-app-gateway` (the default, as ""). */
function gatewayNameFrom(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const name = trimmed === "every-app-gateway" ? "" : trimmed.replace(/^every-app-gateway-/, "");
  const problem = name === "" ? (trimmed === "every-app-gateway" ? null : "a Gateway name is 1 to 16 lowercase letters or digits") : gatewayNameProblem(name);
  if (problem) {
    throw new EveryAppError(
      "INVALID_GATEWAY_URL",
      `--gateway must be the Gateway's URL or its name, not "${value}"\n${problem}.`,
    );
  }
  return name;
}

/** How a run without a terminal logs in: see `ensureCfAuth`. */
type OnDeviceLogin = Parameters<typeof ensureCfAuth>[0]["onDeviceLogin"];

/**
 * Log in to Cloudflare if needed (at a terminal, `cf auth login`; under
 * --json, with `onDeviceLogin`, cf's device link handed to the agent and
 * waited for), then find the Gateway in the login's accounts.
 */
async function loginAndDiscover({
  createCf = defaultCreateCf,
  accountId,
  host,
  name,
  interactive,
  alwaysAsk,
  onDeviceLogin,
}: {
  createCf?: CreateCf;
  /** --account-id */
  accountId?: string;
  /** The host the command names (--gateway, setup's --domain). */
  host?: string;
  /** The name the command names (--gateway <name>; "" is the default Gateway). */
  name?: string;
  interactive: boolean;
  /** The checkout's remembered Gateway is only preselected (discover.ts `alwaysAsk`). */
  alwaysAsk?: boolean;
  onDeviceLogin?: OnDeviceLogin;
}): Promise<{ whoami: CfWhoami; discovery: Discovery }> {
  const whoami = await ensureCfAuth({
    cf: createCf(),
    interactive,
    onDeviceLogin,
  });
  const discovery = await discoverGateway({
    whoami,
    createCf,
    accountId,
    host,
    ...(name !== undefined ? { name: name || null } : {}),
    interactive,
    ...(alwaysAsk ? { alwaysAsk } : {}),
  });
  return { whoami, discovery };
}

/** The Gateway's install row, once a deploy put the Gateway live. */
function requireInstall(
  gateway: FoundGateway,
): FoundGateway & { install: InstallRecord } {
  const { install } = gateway;
  if (!install) throw notDeployedByEveryapp();
  if (install.liveVersionId === null) {
    throw new EveryAppError(
      "GATEWAY_NOT_INSTALLED",
      `The Gateway at https://${install.gatewayHost} isn't finished installing\nSetup stopped before its first upload.`,
      { rerun: `${CLI} setup` },
    );
  }
  return { ...gateway, install };
}

/**
 * The Gateway a command that needs one acts on (`status`), found through
 * the Cloudflare login. None in any account the login sees is the first
 * run: `install_gateway`, whose rerun is setup. None in the account asked
 * for, or no accounts at all, is GATEWAY_NOT_FOUND. Under --json, cf's
 * device login goes to the agent, and the run waits.
 */
export async function existingGateway({
  json,
  out,
  accountId,
  gateway,
  createCf,
}: ExistingGatewayOptions): Promise<FoundGateway> {
  const byUrl = gateway !== undefined && gateway.includes("://");
  const host = byUrl ? new URL(gateway).host.toLowerCase() : undefined;
  const { whoami, discovery } = await loginAndDiscover({
    createCf,
    accountId,
    host,
    name: gateway !== undefined && !byUrl ? gatewayNameFrom(gateway) : undefined,
    interactive: canPromptInTerminal(json ?? false),
    onDeviceLogin: json ? deviceLoginAction(out, "gateway.login") : undefined,
  });
  if (
    discovery.found.length === 0 &&
    discovery.unchecked.length === 0 &&
    discovery.probed.length > 0 &&
    !discovery.requestedAccountId
  ) {
    const accounts = discovery.probed.map((account) => account.name ?? account.id);
    throw new ActionRequiredError(
      "install_gateway",
      [
        `No Gateway in ${accounts.length === 1 ? `${accounts[0]}'s Cloudflare account` : `the ${accounts.length} Cloudflare accounts this login sees`}${whoami.email ? ` (logged in as ${whoami.email})` : ""}`,
        `Gateway in another account? Log in to it: ${CLI} login`,
      ].join("\n"),
      undefined,
      { rerun: `${CLI} setup`, rerunNote: "installs one", data: { accounts: discovery.probed } },
    );
  }
  const found = requireGateway(discovery, whoami, host);
  if (found.install) {
    checkGatewayUrl(found as FoundGateway & { install: InstallRecord }, byUrl ? gateway : undefined);
  }
  return found;
}

interface ExistingGatewayOptions {
  json?: boolean;
  out: EventSink;
  /** --account-id */
  accountId?: string;
  /** What --gateway or EVERYAPP_GATEWAY_URL names (requestedGatewayUrl): a URL or a name. */
  gateway?: string;
  /** cf per account (tests). */
  createCf?: CreateCf;
}

/** The Gateway an app command acts on, installed and live. */
export async function connectToGateway({
  gateway,
  accountId,
  interactive,
  alwaysAsk,
  createCf = defaultCreateCf,
  onNoGateway,
  login,
}: {
  /** The URL `--gateway` or EVERYAPP_GATEWAY_URL names (requestedGatewayUrl). */
  gateway?: string;
  /** --account-id */
  accountId?: string;
  interactive: boolean;
  /**
   * Destroys or replaces something (`delete`, `db restore`): with several
   * Gateways, the person is asked even when the checkout remembers one,
   * which is preselected.
   */
  alwaysAsk?: boolean;
  /** Under --json (`json`), cf's device login goes to the agent on `step`. */
  login?: { json?: boolean; out: EventSink; step: string };
  createCf?: CreateCf;
  /**
   * No account the login sees has a Gateway (`deploy` offers to install
   * one): returns the discovery to go on with, or throws. Never called when
   * the command names a Gateway (--gateway, EVERYAPP_GATEWAY_URL,
   * --account-id, CLOUDFLARE_ACCOUNT_ID) or an account couldn't be asked:
   * those fail (GATEWAY_NOT_FOUND, GATEWAY_CHECK_FAILED), so a Gateway that
   * exists is never installed a second time.
   */
  onNoGateway?: (found: { whoami: CfWhoami; discovery: Discovery }) => Promise<Discovery>;
}): Promise<GatewayConnection> {
  // --gateway: a URL picks by host, a name by name ("" is the default Gateway).
  const byUrl = gateway !== undefined && gateway.includes("://");
  const host = byUrl ? new URL(gateway).host.toLowerCase() : undefined;
  const name = gateway !== undefined && !byUrl ? gatewayNameFrom(gateway) : undefined;
  const loggedIn = await loginAndDiscover({
    createCf,
    accountId,
    host,
    name,
    interactive,
    alwaysAsk,
    onDeviceLogin: login?.json ? deviceLoginAction(login.out, login.step) : undefined,
  });
  const { whoami } = loggedIn;
  let { discovery } = loggedIn;
  const named = host !== undefined || name !== undefined || discovery.requestedAccountId !== undefined;
  if (
    onNoGateway &&
    !named &&
    discovery.gateway === null &&
    discovery.found.length === 0 &&
    discovery.unchecked.length === 0 &&
    discovery.probed.length > 0
  ) {
    discovery = await onNoGateway({ whoami, discovery });
  }
  const found = requireInstall(requireGateway(discovery, whoami, host));
  checkGatewayUrl(found, byUrl ? gateway : undefined);
  return {
    cf: found.cf,
    accountId: found.account.id,
    accountName: found.account.name,
    databaseId: found.databaseId,
    names: found.names,
    db: found.db,
    install: found.install,
    gatewayUrl: `https://${found.install.gatewayHost}`,
    deployer: deployerFor(whoami.email, found.account.id),
  };
}
