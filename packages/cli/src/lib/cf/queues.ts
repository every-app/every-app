/**
 * Cloudflare Queues through `cf queues`, by exact name. An app's queues are
 * created by the deploy (lib/app/resources.ts records each before creating
 * it); their consumers are published by cf's own upload, from the `queue`
 * trigger of the consuming Worker's config. Cloudflare's queue listing
 * lags a create by a few seconds, and can show a new queue, then not, then
 * again (seen live on 2026-10-24), so a lookup of a queue known to exist
 * asks by id and again. These find, list and delete them: a consumer goes before its Worker (Cloudflare refuses to delete a
 * Worker that consumes a queue, code 10064), the queue after the Workers
 * that bind it (code 11005).
 */
import { isCfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import {
  QueueConsumerListOutput,
  QueueListOutput,
  QueueOutput,
  type Queue,
  type QueueConsumer,
} from "./schemas";

/** Every queue in the account (cf lists them in one answer). */
export function listQueues(cf: CfRunner): Promise<Queue[]> {
  return runCfJson(cf, { plane: "account", args: ["queues", "list"] }, QueueListOutput);
}

/** The queue named exactly `name`, or null. */
export async function findQueue(cf: CfRunner, name: string): Promise<Queue | null> {
  return (await listQueues(cf)).find((queue) => queue.queue_name === name) ?? null;
}

/**
 * The queue with this id, or null when Cloudflare says there is none.
 * Right after a create, Cloudflare can answer not found, or 500 (code
 * 10013), for a few seconds (seen live on 2026-10-24): callers that know
 * the queue exists ask again.
 */
export async function getQueue(cf: CfRunner, id: string): Promise<Queue | null> {
  try {
    return await runCfJson(cf, { plane: "account", args: ["queues", "get", id] }, QueueOutput);
  } catch (error) {
    if (isCfError(error, "not_found")) return null;
    throw error;
  }
}

/** Create a queue; fails (`already_exists`, code 11009) when the name is taken. */
export async function createQueue(cf: CfRunner, name: string): Promise<string> {
  const queue = await runCfJson(
    cf,
    { plane: "account", args: ["queues", "create", "--queue-name", name] },
    QueueOutput,
  );
  return queue.queue_id;
}

/**
 * Delete a queue and the messages in it. `--force` answers cf's
 * confirmation, decided as for deleteD1 (lib/cf/resources.ts).
 */
export async function deleteQueue(cf: CfRunner, id: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["queues", "delete", id, "--force"],
  });
}

/** The queue's consumers: the Worker each one is, and its settings. */
export function listQueueConsumers(cf: CfRunner, queueId: string): Promise<QueueConsumer[]> {
  return runCfJson(
    cf,
    { plane: "account", args: ["queues", "consumers", "list", "--queue-id", queueId] },
    QueueConsumerListOutput,
  );
}

/**
 * Detach a consumer from its queue, so its Worker can be deleted; the
 * queue and its messages stay.
 */
export async function deleteQueueConsumer(
  cf: CfRunner,
  queueId: string,
  consumerId: string,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["queues", "consumers", "delete", consumerId, "--queue-id", queueId, "--force"],
  });
}
