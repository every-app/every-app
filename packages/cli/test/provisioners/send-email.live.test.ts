/**
 * Cloudflare's `send_email` binding (`resources.sendEmail`), live on the
 * test account: the bindings the SDK builds from a manifest (restricted
 * to their senders and a destination list, one destination, or no
 * destination; the strict validator requires the senders) upload through
 * the CLI's deploy path, read back as the API stores
 * them, and the Worker is deleted. Nothing is provisioned, so there is
 * nothing else to delete. Skipped without EVERYAPP_LIVE_PROVISIONERS=1
 * (see ./live.ts):
 *
 *   EVERYAPP_LIVE_PROVISIONERS=1 pnpm -C packages/cli exec vitest run test/provisioners/send-email.live.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import { validateManifestStrict } from "@every-app/perimeter/manifest";
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

const WORKER = `${LIVE_PREFIX}send-email`;

describeLive("the send_email binding, live", () => {
  it("uploads the SDK's bindings with their addresses, reads them back and deletes the Worker", async () => {
    const live = await liveAccount();
    const sender = `noreply@${live.zone}`;
    const manifest = validateManifestStrict({
      id: "provisioners",
      resources: {
        sendEmail: [
          { name: "EMAIL", allowedSenderAddresses: [sender], allowedDestinationAddresses: [sender] },
          { name: "PAGER", allowedSenderAddresses: [sender], destinationAddress: sender },
          { name: "SENDER", allowedSenderAddresses: [sender] },
        ],
      },
    });
    // The binding is the same in both modes; development needs no build env.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-live-sdk-"));
    const built = everyAppWorker({
      manifest,
      entrypoint: "./src/index.ts",
      ctx: { mode: "development" },
      root,
    }).env as Record<string, Record<string, unknown> & { type: string }>;
    fs.rmSync(root, { recursive: true, force: true });
    const env = Object.fromEntries(
      Object.entries(built).filter(([, binding]) => binding.type === "send-email"),
    );
    expect(Object.keys(env).sort()).toEqual(["EMAIL", "PAGER", "SENDER"]);

    try {
      const versionId = await uploadPrebuilt(live, { workerName: WORKER, env });
      expect(await getWorkerDeployment(live.cf, WORKER)).toMatchObject({ versionId });
      const bindings = (await readWorkerBindings(live, WORKER)).filter(
        (binding) => binding.type === "send_email",
      );
      // What the API stores, for the PR body and the runbook (no secret in it).
      console.log(JSON.stringify(bindings, null, 2));
      expect(bindings.map((binding) => binding.name).sort()).toEqual(["EMAIL", "PAGER", "SENDER"]);
      const byName = Object.fromEntries(bindings.map((binding) => [binding.name, binding]));
      expect(byName["EMAIL"]).toMatchObject({
        allowed_sender_addresses: [sender],
        allowed_destination_addresses: [sender],
      });
      expect(byName["PAGER"]).toMatchObject({ allowed_sender_addresses: [sender], destination_address: sender });
      expect(byName["SENDER"]).toEqual({ name: "SENDER", type: "send_email", allowed_sender_addresses: [sender] });
    } finally {
      await deleteWorkerQuietly(live, WORKER);
    }
    expect(await getWorkerDeployment(live.cf, WORKER)).toBeNull();
  }, 300_000);
});
