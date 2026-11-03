/**
 * The gateway's own Cloudflare resources, found by name (KV: title) and
 * created when missing: its D1 database and the OAuth provider's KV
 * namespace. The names are the Gateway's (`GatewayNames`, packages/perimeter
 * manifest/gatewayNames.ts): `every-app-gateway` and
 * `every-app-gateway-OAUTH_KV` for the default Gateway, each with
 * `-<name>` after the root for a named one, so two Gateways in one account
 * never share a resource.
 */
import {
  DEFAULT_GATEWAY_NAMES,
  GATEWAY_ROOT,
  gatewayNameOf,
  type GatewayNames,
} from "@every-app/perimeter/manifest";
import type { CfRunner } from "@/lib/cf/runner";
import { listAll } from "@/lib/cf/runner";
import { findD1, findKv, getOrCreateD1, getOrCreateKv } from "@/lib/cf/resources";
import { D1DatabaseListOutput } from "@/lib/cf/schemas";

export interface GatewayResources {
  d1Id: string;
  oauthKvId: string;
  /** What this run created, for the log. */
  created: string[];
}

export async function ensureGatewayResources(
  cf: CfRunner,
  names: GatewayNames = DEFAULT_GATEWAY_NAMES,
): Promise<GatewayResources> {
  const d1 = await getOrCreateD1(cf, names.d1);
  const oauthKv = await getOrCreateKv(cf, names.oauthKv);
  return {
    d1Id: d1.id,
    oauthKvId: oauthKv.id,
    created: [
      ...(d1.created ? [`D1 ${names.d1}`] : []),
      ...(oauthKv.created ? [`KV ${names.oauthKv}`] : []),
    ],
  };
}

/**
 * The gateway's resources when its database and KV namespace are both
 * there, never creating either (`update`, which never installs a Gateway);
 * null when one is missing.
 */
export async function existingGatewayResources(
  cf: CfRunner,
  names: GatewayNames = DEFAULT_GATEWAY_NAMES,
): Promise<GatewayResources | null> {
  const [d1Id, oauthKvId] = await Promise.all([findD1(cf, names.d1), findKv(cf, names.oauthKv)]);
  if (!d1Id || !oauthKvId) return null;
  return { d1Id, oauthKvId, created: [] };
}

/** The gateway's D1 database id, or null when no gateway of these names was deployed here. */
export function findGatewayDatabase(cf: CfRunner, names: GatewayNames = DEFAULT_GATEWAY_NAMES): Promise<string | null> {
  return findD1(cf, names.d1);
}

/** A Gateway's D1 database in an account, with the names it says. */
interface GatewayDatabase {
  id: string;
  names: GatewayNames;
}

/**
 * Every Gateway database in the account: the D1 databases named
 * `every-app-gateway` or `every-app-gateway-<name>` (a valid name; nothing
 * else under the root is one), the default's first, then by name.
 */
export async function listGatewayDatabases(cf: CfRunner): Promise<GatewayDatabase[]> {
  // --name matches loosely: everything holding the root, then the exact shapes.
  const databases = await listAll(
    cf,
    ["d1", "list", "--name", GATEWAY_ROOT],
    D1DatabaseListOutput,
    { perPage: 100, maxPages: 10 },
  );
  return databases
    .flatMap((database) => {
      const names = gatewayNameOf(database.name);
      return names ? [{ id: database.uuid, names }] : [];
    })
    .sort((a, b) => (a.names.name ?? "").localeCompare(b.names.name ?? ""));
}
