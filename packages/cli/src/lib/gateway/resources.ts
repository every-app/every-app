/**
 * The gateway's own Cloudflare resources, found by name (KV: title) and
 * created when missing: its D1 database, the OAuth provider's KV
 * namespace, and the activation queue the CLI nudges once it has bound an
 * app (the Gateway's `queue` handler sweeps `binding` apps at once, rather
 * than at the next cron, which a fresh Gateway doesn't run for minutes).
 */
import { createQueue, findQueue } from "@/lib/cf/queues";
import type { CfRunner } from "@/lib/cf/runner";
import { findD1, findKv, getOrCreateD1, getOrCreateKv } from "@/lib/cf/resources";

const GATEWAY_D1_NAME = "every-app-gateway";
const GATEWAY_OAUTH_KV_TITLE = "every-app-gateway-OAUTH_KV";
/** apps/every-app-gateway/cloudflare.config.ts consumes it under the same name. */
const GATEWAY_ACTIVATION_QUEUE = "every-app-gateway-activate";

/** The activation queue, created when missing: a Gateway release consumes it, and an upload with --no-provision needs it there. */
async function ensureActivationQueue(cf: CfRunner): Promise<boolean> {
  if (await findQueue(cf, GATEWAY_ACTIVATION_QUEUE)) return false;
  await createQueue(cf, GATEWAY_ACTIVATION_QUEUE);
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
): Promise<GatewayResources> {
  const d1 = await getOrCreateD1(cf, GATEWAY_D1_NAME);
  const oauthKv = await getOrCreateKv(cf, GATEWAY_OAUTH_KV_TITLE);
  const queueCreated = await ensureActivationQueue(cf);
  return {
    d1Id: d1.id,
    oauthKvId: oauthKv.id,
    created: [
      ...(d1.created ? [`D1 ${GATEWAY_D1_NAME}`] : []),
      ...(oauthKv.created ? [`KV ${GATEWAY_OAUTH_KV_TITLE}`] : []),
      ...(queueCreated ? [`queue ${GATEWAY_ACTIVATION_QUEUE}`] : []),
    ],
  };
}

/**
 * The gateway's resources when its database and KV namespace are both
 * there, never creating either (`update`, which never installs a Gateway);
 * null when one is missing. The activation queue, which holds nothing, is
 * created when missing (a Gateway installed before it).
 */
export async function existingGatewayResources(cf: CfRunner): Promise<GatewayResources | null> {
  const [d1Id, oauthKvId] = await Promise.all([
    findD1(cf, GATEWAY_D1_NAME),
    findKv(cf, GATEWAY_OAUTH_KV_TITLE),
  ]);
  if (!d1Id || !oauthKvId) return null;
  const queueCreated = await ensureActivationQueue(cf);
  return { d1Id, oauthKvId, created: queueCreated ? [`queue ${GATEWAY_ACTIVATION_QUEUE}`] : [] };
}

/**
 * Nudge the Gateway to make `binding` apps live now (its `queue` handler),
 * rather than at its next cron: behind Cloudflare Access the deploy's own
 * probe never reaches it. Best effort: no queue (a Gateway from before it)
 * or a failed push leaves the cron to do it, and nothing is said.
 */
export async function nudgeActivation(cf: CfRunner): Promise<boolean> {
  try {
    const queue = await findQueue(cf, GATEWAY_ACTIVATION_QUEUE);
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

/** The gateway's D1 database id, or null when no gateway was deployed here. */
export function findGatewayDatabase(cf: CfRunner): Promise<string | null> {
  return findD1(cf, GATEWAY_D1_NAME);
}
