/**
 * Workers AI (`resources.ai`), live on the test account: a Worker bound to
 * Workers AI exactly as everyAppWorker() builds it for production uploads
 * through the CLI's own `cf deploy --prebuilt` path, Cloudflare stores the
 * binding, and the Worker is deleted. Nothing else is made: the binding is
 * account-wide. Skipped without EVERYAPP_LIVE_PROVISIONERS=1 (see ./live.ts):
 *
 *   EVERYAPP_LIVE_PROVISIONERS=1 pnpm -C packages/cli exec vitest run test/provisioners/ai.live.test.ts
 */
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import { expect, it, vi } from "vitest";
import { getWorkerDeployment } from "@/lib/cf/workers";
import {
  deleteWorkerQuietly,
  describeLive,
  liveAccount,
  LIVE_PREFIX,
  readWorkerBindings,
  uploadPrebuilt,
} from "./live";

const WORKER = `${LIVE_PREFIX}ai`;

/** The `AI` binding of a production build of a manifest declaring `resources.ai`. */
function builtAiBinding(): Record<string, unknown> & { type: string } {
  vi.stubEnv("EVERYAPP_BUILD", "1");
  try {
    const { env } = everyAppWorker({
      manifest: { id: "provisioners-ai", resources: { ai: ["AI"] } },
      entrypoint: "./src/entry.worker.ts",
      ctx: { mode: "production" },
    });
    return (env as Record<string, Record<string, unknown> & { type: string }>)["AI"]!;
  } finally {
    vi.unstubAllEnvs();
  }
}

describeLive("Workers AI (resources.ai), live", () => {
  it("uploads a Worker with the binding the SDK builds, reads it back as Cloudflare stores it, and deletes the Worker", async () => {
    const live = await liveAccount();
    const binding = builtAiBinding();
    expect(binding).toEqual({ type: "ai" });
    try {
      const versionId = await uploadPrebuilt(live, { workerName: WORKER, env: { AI: binding } });
      expect(await getWorkerDeployment(live.cf, WORKER)).toMatchObject({ versionId });
      const bindings = await readWorkerBindings(live, WORKER);
      expect(bindings).toContainEqual(expect.objectContaining({ name: "AI", type: "ai" }));
      // What the API stored, for the PR body: the binding's fields, no secrets in it.
      console.log(JSON.stringify(bindings.find((stored) => stored.name === "AI")));
    } finally {
      await deleteWorkerQuietly(live, WORKER);
    }
    expect(await getWorkerDeployment(live.cf, WORKER)).toBeNull();
  }, 300_000);
});
