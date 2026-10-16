/**
 * The gateway an app command acts on, reached the one way there is in
 * self-host: the operator's Cloudflare login (or CLOUDFLARE_API_TOKEN), the
 * gateway's D1 database in that account, and its install row. Nothing is
 * asked of the gateway over HTTPS and nothing is kept on this machine but
 * `~/.everyapp/installs.json`, which only says which account to look in.
 *
 * `--gateway` and EVERYAPP_GATEWAY_URL (meant for the hosted tier) only pick
 * which install to look up here; the URL itself always comes from the
 * install row, and one that names another host is refused.
 */
import { ensureCfAuth, resolveAccount } from "@/lib/cf/account";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { rememberedInstall } from "@/lib/install/state";
import { notDeployedByEveryapp } from "./apply";
import { readInstall, type InstallRecord } from "./install";
import { deployerFor, type Deployer } from "./registry";
import { findGatewayDatabase } from "./resources";

interface GatewayConnection {
  /** cf, pinned to the gateway's account. */
  cf: CfRunner;
  accountId: string;
  /** The account's name, when cf lists it. */
  accountName: string | null;
  /** The gateway's D1: its registry, install row, leases and ledgers. */
  db: D1Database;
  install: InstallRecord;
  gatewayUrl: string;
  /** Who acts: the Cloudflare login's email, or the account's API token. */
  deployer: Deployer;
}

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

export async function connectToGateway({
  gateway,
  interactive,
  createCf = (accountId?: string) => createCfRunner({ accountId }),
}: {
  /** The URL `--gateway` or EVERYAPP_GATEWAY_URL names (requestedGatewayUrl). */
  gateway?: string;
  interactive: boolean;
  createCf?: (accountId?: string) => CfRunner;
}): Promise<GatewayConnection> {
  const requestedHost = gateway ? new URL(gateway).host.toLowerCase() : undefined;
  const whoami = await ensureCfAuth({ cf: createCf(), interactive });
  const remembered = await rememberedInstall(requestedHost);
  const account = await resolveAccount({
    whoami,
    remembered: remembered?.accountId,
    interactive,
  });
  const cf = createCf(account.id);
  const databaseId = await findGatewayDatabase(cf);
  if (!databaseId) {
    throw new EveryAppError(
      "GATEWAY_NOT_FOUND",
      `Cloudflare account ${account.name ?? account.id} has no gateway${whoami.email ? ` (cf is logged in as ${whoami.email})` : ""}. Install one with \`everyapp setup\`, or log in to the gateway's account: npx cf auth login (or set CLOUDFLARE_ACCOUNT_ID).`,
    );
  }
  const db = cfD1Database(cf, databaseId);
  const install = await readInstall(db);
  if (!install) throw notDeployedByEveryapp();
  const gatewayUrl = `https://${install.gatewayHost}`;
  if (requestedHost && requestedHost !== install.gatewayHost.toLowerCase()) {
    throw new EveryAppError(
      "GATEWAY_URL_MISMATCH",
      `The gateway in Cloudflare account ${account.name ?? account.id} is ${gatewayUrl}, not ${gateway}. Drop --gateway (and EVERYAPP_GATEWAY_URL), or log in to the account that gateway runs in.`,
    );
  }
  return {
    cf,
    accountId: account.id,
    accountName: account.name,
    db,
    install,
    gatewayUrl,
    deployer: deployerFor(whoami.email, account.id),
  };
}
