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
import { deviceLoginAction, ensureCfAuth } from "@/lib/cf/account";
import type { D1Database } from "@/lib/cf/d1";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { EveryAppError } from "@/lib/errors";
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

/** The gateway URL `--gateway` or EVERYAPP_GATEWAY_URL names, if either does. */
export function requestedGatewayUrl(flag?: string): string | undefined {
  if (flag) return normalizeGatewayUrl(flag, "--gateway");
  const fromEnv = process.env["EVERYAPP_GATEWAY_URL"];
  return fromEnv ? normalizeGatewayUrl(fromEnv, "EVERYAPP_GATEWAY_URL") : undefined;
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
  interactive,
  onDeviceLogin,
}: {
  createCf?: CreateCf;
  /** --account-id */
  accountId?: string;
  /** The host the command names (--gateway, setup's --domain). */
  host?: string;
  interactive: boolean;
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
    interactive,
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
      `The Gateway at https://${install.gatewayHost} never finished installing`,
      { rerun: `${CLI} setup` },
    );
  }
  return { ...gateway, install };
}

/**
 * The Gateway a command that needs one acts on (`status`), found through
 * the Cloudflare login: GATEWAY_NOT_FOUND when there is none. Under --json,
 * cf's device login goes to the agent, and the run waits.
 */
export async function existingGateway({
  json,
  out,
  accountId,
  createCf,
}: ExistingGatewayOptions): Promise<FoundGateway> {
  const { whoami, discovery } = await loginAndDiscover({
    createCf,
    accountId,
    interactive: canPromptInTerminal(json ?? false),
    onDeviceLogin: json ? deviceLoginAction(out, "gateway.login") : undefined,
  });
  return requireGateway(discovery, whoami);
}

interface ExistingGatewayOptions {
  json?: boolean;
  out: EventSink;
  /** --account-id */
  accountId?: string;
  /** cf per account (tests). */
  createCf?: CreateCf;
}

/** The Gateway an app command acts on, installed and live. */
export async function connectToGateway({
  gateway,
  accountId,
  interactive,
  createCf = defaultCreateCf,
  onNoGateway,
  login,
}: {
  /** The URL `--gateway` or EVERYAPP_GATEWAY_URL names (requestedGatewayUrl). */
  gateway?: string;
  /** --account-id */
  accountId?: string;
  interactive: boolean;
  /** Under --json (`json`), cf's device login goes to the agent on `step`. */
  login?: { json?: boolean; out: EventSink; step: string };
  createCf?: CreateCf;
  /**
   * No account the login sees has a Gateway (`deploy` offers to install
   * one): returns the discovery to go on with, or throws.
   */
  onNoGateway?: (found: { whoami: CfWhoami; discovery: Discovery }) => Promise<Discovery>;
}): Promise<GatewayConnection> {
  const loggedIn = await loginAndDiscover({
    createCf,
    accountId,
    host: gateway ? new URL(gateway).host.toLowerCase() : undefined,
    interactive,
    onDeviceLogin: login?.json ? deviceLoginAction(login.out, login.step) : undefined,
  });
  const { whoami } = loggedIn;
  let { discovery } = loggedIn;
  if (
    onNoGateway &&
    discovery.gateway === null &&
    discovery.found.length === 0 &&
    discovery.probed.length > 0
  ) {
    discovery = await onNoGateway({ whoami, discovery });
  }
  const found = requireInstall(requireGateway(discovery, whoami));
  checkGatewayUrl(found, gateway);
  return {
    cf: found.cf,
    accountId: found.account.id,
    accountName: found.account.name,
    databaseId: found.databaseId,
    db: found.db,
    install: found.install,
    gatewayUrl: `https://${found.install.gatewayHost}`,
    deployer: deployerFor(whoami.email, found.account.id),
  };
}
