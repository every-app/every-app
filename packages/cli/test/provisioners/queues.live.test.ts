/**
 * Queues, live on the test account (loop-1 only): the deploy's `cf`
 * calls for a queue (lib/cf/queues.ts) find and create it once, a
 * prebuilt Worker uploads through the CLI's deploy path with the producer
 * binding and a consumer trigger (cf publishes the consumer), and the
 * deletion order Cloudflare enforces holds: the consumer, then the
 * Worker, then the queue. Skipped without EVERYAPP_LIVE_PROVISIONERS=1
 * (see ./live.ts).
 */
import { expect, it } from "vitest";
import { isCfError } from "@/lib/cf/errors";
import {
  createQueue,
  deleteQueue,
  deleteQueueConsumer,
  findQueue,
  listQueueConsumers,
  listQueues,
} from "@/lib/cf/queues";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorker, getWorkerDeployment } from "@/lib/cf/workers";
import {
  deleteWorkerQuietly,
  describeLive,
  liveAccount,
  LIVE_PREFIX,
  readWorkerBindings,
  uploadPrebuilt,
} from "./live";

const WORKER = `${LIVE_PREFIX}queues`;
const QUEUE = `${WORKER}--jobs`;
const DEAD_LETTERS = `${WORKER}--failed-jobs`;
/** A queue no one creates: a producer bound to it is refused under --no-provision. */
const MISSING = `${WORKER}--missing`;

/**
 * Until `settled(found)` holds of the queue `name` in the listing, which
 * lags a create or a delete by a few seconds; the last answer.
 */
async function listedUntil(
  cf: CfRunner,
  name: string,
  settled: (found: boolean) => boolean,
): Promise<boolean> {
  let found = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    found = (await findQueue(cf, name)) !== null;
    if (settled(found)) return found;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return found;
}

/** The deploy's ensure for one queue: found by its exact name, else created. */
async function ensureQueue(cf: CfRunner, name: string): Promise<{ id: string; created: boolean }> {
  const found = await findQueue(cf, name);
  if (found) return { id: found.queue_id, created: false };
  return { id: await createQueue(cf, name), created: true };
}

/** What a stopped run left: the Worker's consumers, the Worker, the test's queues. */
async function cleanUp(cf: CfRunner, live: Awaited<ReturnType<typeof liveAccount>>): Promise<void> {
  const ours = (await listQueues(cf)).filter((queue) => queue.queue_name.startsWith(WORKER));
  for (const queue of ours) {
    for (const consumer of queue.consumers ?? []) {
      if (consumer.script === WORKER && consumer.consumer_id) {
        await deleteQueueConsumer(cf, queue.queue_id, consumer.consumer_id);
      }
    }
  }
  await deleteWorkerQuietly(live, WORKER);
  for (const queue of ours) {
    try {
      await deleteQueue(cf, queue.queue_id);
    } catch (error) {
      if (!isCfError(error, "not_found")) throw error;
    }
  }
}

describeLive("Queues on the test account", () => {
  it("creates a queue once, uploads a Worker producing to and consuming it, and deletes consumer, Worker and queue in order", async () => {
    const live = await liveAccount();
    const { cf } = live;
    await cleanUp(cf, live);
    try {
      // --no-provision: a producer bound to a missing queue is refused before the upload, and nothing is made.
      await expect(
        uploadPrebuilt(live, { workerName: WORKER, env: { JOBS: { type: "queue", name: MISSING } } }),
      ).rejects.toThrow(/does not exist/);
      expect(await getWorkerDeployment(cf, WORKER)).toBeNull();
      expect(await findQueue(cf, MISSING)).toBeNull();

      // Ensure twice: the second finds the first, and a create of a taken name is already_exists (11009).
      const first = await ensureQueue(cf, QUEUE);
      expect(first.created).toBe(true);
      expect(await listedUntil(cf, QUEUE, (found) => found)).toBe(true);
      const second = await ensureQueue(cf, QUEUE);
      expect(second).toEqual({ id: first.id, created: false });
      const error = await createQueue(cf, QUEUE).catch((caught: unknown) => caught);
      expect(isCfError(error, "already_exists")).toBe(true);
      const deadLetters = await ensureQueue(cf, DEAD_LETTERS);
      expect(await listedUntil(cf, DEAD_LETTERS, (found) => found)).toBe(true);

      // The upload publishes the consumer from the trigger.
      await uploadPrebuilt(live, {
        workerName: WORKER,
        env: { JOBS: { type: "queue", name: QUEUE } },
        triggers: [{ type: "queue", name: QUEUE, deadLetterQueue: DEAD_LETTERS, maxBatchSize: 1, maxBatchTimeout: 1 }],
        queueHandler: true,
      });
      expect(await readWorkerBindings(live, WORKER)).toContainEqual(
        expect.objectContaining({ name: "JOBS", type: "queue", queue_name: QUEUE }),
      );
      const consumers = await listQueueConsumers(cf, first.id);
      expect(consumers).toEqual([
        expect.objectContaining({ script: WORKER, type: "worker", dead_letter_queue: DEAD_LETTERS }),
      ]);
      expect((await findQueue(cf, QUEUE))?.consumers).toEqual([
        expect.objectContaining({ script: WORKER, consumer_id: consumers[0]!.consumer_id }),
      ]);

      // Cloudflare's order: a bound queue can't go (11005), nor a consuming Worker (10064).
      const inUse = await deleteQueue(cf, first.id).catch((caught: unknown) => caught);
      expect(isCfError(inUse, "queue_in_use")).toBe(true);
      const consuming = await deleteWorker(cf, WORKER, { withReferences: true }).catch((caught: unknown) => caught);
      expect(isCfError(consuming, "queue_consumer_worker")).toBe(true);

      await deleteQueueConsumer(cf, first.id, consumers[0]!.consumer_id);
      expect(await listQueueConsumers(cf, first.id)).toEqual([]);
      expect(await deleteWorkerQuietly(live, WORKER)).toBe(true);
      await deleteQueue(cf, first.id);
      await deleteQueue(cf, deadLetters.id);
      expect(await listedUntil(cf, QUEUE, (found) => !found)).toBe(false);
      expect(await listedUntil(cf, DEAD_LETTERS, (found) => !found)).toBe(false);
      expect(await getWorkerDeployment(cf, WORKER)).toBeNull();
    } finally {
      await cleanUp(cf, live);
    }
    for (const name of [QUEUE, DEAD_LETTERS, MISSING]) {
      expect(await listedUntil(cf, name, (found) => !found)).toBe(false);
    }
    expect(await getWorkerDeployment(cf, WORKER)).toBeNull();
  }, 600_000);
});
