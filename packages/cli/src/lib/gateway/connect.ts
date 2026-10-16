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
import { ensureCfAuth } from "@/lib/cf/account";
import type { D1Database } from "@/lib/cf/d1";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { CfWhoami } from "@/lib/cf/schemas";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { notDeployedByEveryapp } from "./apply";
import {
  checkGatewayUrl,
  discoverGateway,
  requireGateway,
  type Discovery,
  type FoundGateway,
} from "./discover";
import type { InstallRecord } from "./install";
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

/** A gateway URL as `--gateway` takes it: no path, query or trailing slash. */
function normalizeGatewayUrl(gatewayUrl: string): string {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new EveryAppError(
      "INVALID_GATEWAY_URL",
      `"${gatewayUrl}" isn't a URL; pass the gateway's, e.g. https://apps.example.com.`,
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/** The gateway URL `--gateway` or EVERYAPP_GATEWAY_URL names, if either does. */
export function requestedGatewayUrl(flag?: string): string | undefined {
  const explicit = flag ?? process.env["EVERYAPP_GATEWAY_URL"];
  return explicit ? normalizeGatewayUrl(explicit) : undefined;
}

/** How a run without a terminal logs in: see `ensureCfAuth`. */
type OnDeviceLogin = Parameters<typeof ensureCfAuth>[0]["onDeviceLogin"];

/**
 * Log in to Cloudflare if needed (at a terminal, `cf auth login`; under
 * --json, with `onDeviceLogin`, cf's device link handed to the agent and
 * waited for), then find the Gateway in the login's accounts.
 */
export async function loginAndDiscover({
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
export function requireInstall(
  gateway: FoundGateway,
): FoundGateway & { install: InstallRecord } {
  const { install } = gateway;
  if (!install) throw notDeployedByEveryapp();
  if (install.liveVersionId === null) {
    throw new EveryAppError(
      "GATEWAY_NOT_INSTALLED",
      `The Gateway at https://${install.gatewayHost} stopped before its first upload finished. Finish installing it: ${CLI} setup`,
      { rerun: `${CLI} setup` },
    );
  }
  return { ...gateway, install };
}

/** The Gateway an app command acts on, installed and live. */
export async function connectToGateway({
  gateway,
  accountId,
  interactive,
  onDeviceLogin,
  createCf = defaultCreateCf,
}: {
  /** The URL `--gateway` or EVERYAPP_GATEWAY_URL names (requestedGatewayUrl). */
  gateway?: string;
  /** --account-id */
  accountId?: string;
  interactive: boolean;
  /** Under --json: hand cf's device login to the agent, and wait for it. */
  onDeviceLogin?: OnDeviceLogin;
  createCf?: CreateCf;
}): Promise<GatewayConnection> {
  const { whoami, discovery } = await loginAndDiscover({
    createCf,
    accountId,
    host: gateway ? new URL(gateway).host.toLowerCase() : undefined,
    interactive,
    onDeviceLogin,
  });
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
