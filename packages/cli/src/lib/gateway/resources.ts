/**
 * The gateway's own Cloudflare resources, found by name (KV: title) and
 * created when missing: its D1 database, the OAuth provider's KV
 * namespace, and the activation queue the CLI nudges once it has bound an
 * app (the Gateway's `queue` handler sweeps `binding` apps at once, rather
 * than at the next cron, which a fresh Gateway doesn't run for minutes).
 * The names are the Gateway's (`GatewayNames`, packages/perimeter
 * manifest/gatewayNames.ts): `every-app-gateway`, `every-app-gateway-OAUTH_KV`
 * and `every-app-gateway-activate` for the default Gateway, each with
 * `-<name>` after the root for a named one, so two Gateways in one account
 * never share a resource.
 */
import {
  DEFAULT_GATEWAY_NAMES,
  GATEWAY_ROOT,
  gatewayNameOf,
  type GatewayNames,
} from "@every-app/perimeter/manifest";
import { createQueue, findQueue } from "@/lib/cf/queues";
import type { CfRunner } from "@/lib/cf/runner";
import { listAll } from "@/lib/cf/runner";
import { findD1, findKv, getOrCreateD1, getOrCreateKv } from "@/lib/cf/resources";
import { D1DatabaseListOutput } from "@/lib/cf/schemas";

/** The activation queue, created when missing: a Gateway release consumes it, and an upload with --no-provision needs it there. */
async function ensureActivationQueue(cf: CfRunner, names: GatewayNames): Promise<boolean> {
  if (await findQueue(cf, names.activationQueue)) return false;
  await createQueue(cf, names.activationQueue);
  return true;
}

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
  const queueCreated = await ensureActivationQueue(cf, names);
  return {
    d1Id: d1.id,
    oauthKvId: oauthKv.id,
    created: [
      ...(d1.created ? [`D1 ${names.d1}`] : []),
      ...(oauthKv.created ? [`KV ${names.oauthKv}`] : []),
      ...(queueCreated ? [`queue ${names.activationQueue}`] : []),
    ],
  };
}

/**
 * The gateway's resources when its database and KV namespace are both
 * there, never creating either (`update`, which never installs a Gateway);
 * null when one is missing. The activation queue, which holds nothing, is
 * created when missing (a Gateway installed before it).
 */
export async function existingGatewayResources(
  cf: CfRunner,
  names: GatewayNames = DEFAULT_GATEWAY_NAMES,
): Promise<GatewayResources | null> {
  const [d1Id, oauthKvId] = await Promise.all([findD1(cf, names.d1), findKv(cf, names.oauthKv)]);
  if (!d1Id || !oauthKvId) return null;
  const queueCreated = await ensureActivationQueue(cf, names);
  return { d1Id, oauthKvId, created: queueCreated ? [`queue ${names.activationQueue}`] : [] };
}

/**
 * Nudge the Gateway to make `binding` apps live now (its `queue` handler),
 * rather than at its next cron: behind Cloudflare Access the deploy's own
 * probe never reaches it. Best effort: no queue (a Gateway from before it)
 * or a failed push leaves the cron to do it, and nothing is said.
 */
export async function nudgeActivation(cf: CfRunner, names: GatewayNames = DEFAULT_GATEWAY_NAMES): Promise<boolean> {
  try {
    const queue = await findQueue(cf, names.activationQueue);
    if (!queue) return false;
    await cf.run({
      plane: "account",
      mode: "json",
      args: (files) => ["queues", "messages", "push", queue.queue_id, "--body", `@${files["body.json"]!}`],
      files: { "body.json": { body: { activate: true }, content_type: "json" } },
    });
    return true;
  } catch {
    return false;
  }
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
