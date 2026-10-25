/**
 * Analytics Engine (`resources.analyticsEngine`), live on the test account:
 * a Worker bound to a dataset exactly as everyAppWorker() builds it for
 * production and the deploy installs it (the default dataset named after
 * the Worker) uploads through the CLI's own `cf deploy --prebuilt` path,
 * Cloudflare stores the binding, the SQL API reads the dataset's name
 * double-quoted, and the Worker is deleted. Nothing else is made: a dataset
 * exists once written to, and Cloudflare has no delete for one. Skipped
 * without EVERYAPP_LIVE_PROVISIONERS=1 (see ./live.ts):
 *
 *   EVERYAPP_LIVE_PROVISIONERS=1 pnpm -C packages/cli exec vitest run test/provisioners/analytics-engine.live.test.ts
 */
import { BUILD_SENTINEL, everyAppWorker } from "@every-app/sdk/cloudflare";
import { expect, it, vi } from "vitest";
import { installWorkerConfig } from "@/lib/app/installBuildOutput";
import { getWorkerDeployment } from "@/lib/cf/workers";
import {
  deleteWorkerQuietly,
  describeLive,
  liveAccount,
  LIVE_PREFIX,
  readWorkerBindings,
  uploadPrebuilt,
} from "./live";

const WORKER = `${LIVE_PREFIX}analytics-engine`;
const DATASET = `${WORKER}--events`;

type Binding = Record<string, unknown> & { type: string };

/** The `EVENTS` binding of a production build declaring `resources.analyticsEngine`, installed for {@link WORKER}. */
function installedDatasetBinding(): Binding {
  vi.stubEnv("EVERYAPP_BUILD", "1");
  try {
    const { env } = everyAppWorker({
      manifest: { id: "provisioners-analytics-engine", resources: { analyticsEngine: [{ name: "EVENTS" }] } },
      entrypoint: "./src/entry.worker.ts",
      ctx: { mode: "production" },
    });
    const built = (env as Record<string, Binding>)["EVENTS"]!;
    const installed = installWorkerConfig(
      { name: BUILD_SENTINEL.workerName, env: { EVENTS: built } },
      {
        workerName: WORKER,
        organizationId: "org",
        gatewayUrl: "https://gateway.invalid",
        identityPublicKeys: [],
        resources: {},
      },
    );
    return (installed.env as Record<string, Binding>)["EVENTS"]!;
  } finally {
    vi.unstubAllEnvs();
  }
}

describeLive("Analytics Engine (resources.analyticsEngine), live", () => {
  it("uploads a Worker with the binding the SDK builds and the deploy installs, reads it back as Cloudflare stores it, queries the dataset by its quoted name, and deletes the Worker", async () => {
    const live = await liveAccount();
    const binding = installedDatasetBinding();
    expect(binding).toEqual({ type: "analytics-engine-dataset", name: DATASET });
    try {
      const versionId = await uploadPrebuilt(live, { workerName: WORKER, env: { EVENTS: binding } });
      expect(await getWorkerDeployment(live.cf, WORKER)).toMatchObject({ versionId });
      const bindings = await readWorkerBindings(live, WORKER);
      expect(bindings).toContainEqual(
        expect.objectContaining({ name: "EVENTS", type: "analytics_engine", dataset: DATASET }),
      );
      // What the API stored, for the PR body: the binding's fields, no secrets in it.
      console.log(JSON.stringify(bindings.find((stored) => stored.name === "EVENTS")));
      // The default name holds `-`, which the SQL API's parser reads as
      // minus unless the name is double-quoted.
      const { stdout } = await live.cf.run({
        plane: "account",
        mode: "text",
        args: ["analytics_engine", "sql", "query", "--body", `SELECT count() AS writes FROM "${DATASET}"`],
      });
      const result = JSON.parse(stdout) as { data: Array<{ writes: string }> };
      expect(result.data).toEqual([{ writes: "0" }]);
    } finally {
      await deleteWorkerQuietly(live, WORKER);
    }
    expect(await getWorkerDeployment(live.cf, WORKER)).toBeNull();
  }, 300_000);
});
