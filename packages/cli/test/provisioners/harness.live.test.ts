/**
 * The harness itself, live: the account gate holds, a plain Worker
 * uploads through the CLI's deploy path, reads back and is deleted.
 * Skipped without EVERYAPP_LIVE_PROVISIONERS=1 (see ./live.ts).
 */
import { expect, it } from "vitest";
import { getWorkerDeployment } from "@/lib/cf/workers";
import {
  deleteWorkerQuietly,
  describeLive,
  liveAccount,
  LIVE_PREFIX,
  readWorkerBindings,
  uploadPrebuilt,
} from "./live";

const WORKER = `${LIVE_PREFIX}harness`;

describeLive("the live harness", () => {
  it("authenticates with the test account's token, uploads a Worker, reads it back and deletes it", async () => {
    const live = await liveAccount();
    expect(live.accountId).toMatch(/^[0-9a-f]{32}$/);
    try {
      const versionId = await uploadPrebuilt(live, {
        workerName: WORKER,
        env: { GREETING: { type: "text", value: "hello" } },
      });
      expect(versionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await getWorkerDeployment(live.cf, WORKER)).toMatchObject({ versionId });
      const bindings = await readWorkerBindings(live, WORKER);
      expect(bindings).toContainEqual(expect.objectContaining({ name: "GREETING", type: "plain_text" }));
    } finally {
      await deleteWorkerQuietly(live, WORKER);
    }
    expect(await getWorkerDeployment(live.cf, WORKER)).toBeNull();
  }, 300_000);
});
