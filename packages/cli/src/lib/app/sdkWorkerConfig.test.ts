/**
 * The SDK's Worker definitions against `@cloudflare/config` 0.24.1, the
 * version `cf` and the Vite plugin (2.0.0-beta.sha-91c870c02) pin. The SDK
 * copies cf's binding shapes rather than depending on cf, so this is where
 * the two meet: tsc (`pnpm types:check`) checks the assignments, vitest the
 * values.
 *
 * - `everyAppWorker()` is what an app's `cloudflare.config.ts` hands
 *   `defineConfig()`, its own Durable Objects naming it by definition.
 * - `everyAppAuxiliaryWorker()` is what its `vite.config.ts` hands the
 *   plugin's `auxiliaryWorkers` ("A second Worker" in the build-every-app
 *   skill's patterns): a `WorkerConfigProvider`, which the plugin runs
 *   through `InputWorkerSchema.parse()`. The schema's input is narrower than
 *   `defineConfig()`'s: a binding names another Worker by name only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defineConfig,
  InputWorkerSchema,
  type InputWorkerConfig,
  type ParsedInputWorkerConfig,
} from "@cloudflare/config";
import {
  everyAppAuxiliaryWorker,
  everyAppWorker,
  type EveryAppWorkerManifest,
} from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `@cloudflare/vite-plugin`'s type of an auxiliary Worker's `config`, verbatim. */
type WorkerConfigProvider =
  | InputWorkerConfig
  | ((options: { entryWorkerConfig: ParsedInputWorkerConfig }) => InputWorkerConfig);

/** Every resource kind, with classes, a Hyperdrive config and a queue on the helper too. */
const manifest = {
  id: "every-acme-seo",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    r2: ["R2", "UPLOADS"],
    durableObjects: [
      { name: "USER_SYNC", className: "UserSyncDO" },
      { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
    ],
    workflows: [
      { name: "DIGEST", className: "DigestWorkflow" },
      { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
    ],
    hyperdrive: [{ name: "HYPERDRIVE" }, { name: "CRAWL_DB", worker: "audit" }],
    queues: [
      { name: "JOBS", consumer: { worker: "audit", maxBatchSize: 10, deadLetterQueue: "DEAD" } },
      { name: "DEAD", consumer: true },
    ],
    ai: ["AI"],
    browser: ["BROWSER"],
    images: ["IMAGES"],
    vectorize: [{ name: "VECTORS", dimensions: 768, metric: "cosine" }],
    aiGateway: [{ name: "AI_GATEWAY" }],
    sendEmail: [
      { name: "EMAIL", allowedSenderAddresses: ["hi@acme.example"] },
      { name: "ALERTS", destinationAddress: "ops@acme.example" },
    ],
  },
  workers: [{ name: "audit", binding: "AUDIT", limits: { cpuMs: 60_000 } }],
  database: { provider: "postgres", region: "aws:us-east-1" },
  limits: { cpuMs: 30_000 },
  providers: ["openai"],
  capabilities: { email: {} },
  secrets: ["SEARCH_API_KEY"],
} as const satisfies EveryAppWorkerManifest;

/** A `cf-worker` import of the entry module, as cf hands it to the config. */
const entrypoint = {
  default: { fetch: () => new Response() },
  UserSyncDO: class UserSyncDO {},
  DigestWorkflow: class DigestWorkflow {},
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-sdk-worker-config-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each(["development", "production"])("in %s", (mode) => {
  beforeEach(() => {
    // `everyapp deploy` sets it for a production build.
    if (mode === "production") vi.stubEnv("EVERYAPP_BUILD", "1");
  });

  it("builds a helper Worker the Vite plugin's auxiliaryWorkers take", () => {
    const auxiliaryWorkers: { config: WorkerConfigProvider }[] = [
      {
        config: ({ entryWorkerConfig }) =>
          everyAppAuxiliaryWorker({
            manifest,
            worker: "audit",
            entrypoint: "./src/audit.ts",
            ctx: { mode },
            root,
            crons: ["0 6 * * *"],
            compatibilityFlags: entryWorkerConfig.compatibilityFlags,
          }),
      },
      {
        config: everyAppAuxiliaryWorker({
          manifest,
          worker: "audit",
          entrypoint: "./src/audit.ts",
          ctx: { mode },
          root,
        }),
      },
    ];

    const entryWorkerConfig = InputWorkerSchema.parse(
      everyAppWorker({ manifest, entrypoint: "./src/entry.worker.ts", ctx: { mode }, root }),
    );
    for (const { config } of auxiliaryWorkers) {
      const helper = typeof config === "function" ? config({ entryWorkerConfig }) : config;
      const parsed = InputWorkerSchema.safeParse(helper);
      expect(parsed.error?.issues ?? []).toEqual([]);
      // The helper defines it, and names itself by name.
      expect(parsed.data?.env?.["SCRATCHPAD"]).toEqual({
        type: "durable-object",
        worker: helper.name,
        exportName: "Scratchpad",
      });
    }
  });

  it("builds the app's Worker defineConfig() takes, its own classes named by definition", () => {
    const config = defineConfig((ctx) => ({
      worker: everyAppWorker({ manifest, entrypoint, ctx, root }),
    }));

    const { worker } = config({ mode, isPreview: false });
    expect(worker.env.USER_SYNC.worker).toEqual({
      name: worker.name,
      compatibilityDate: worker.compatibilityDate,
      entrypoint,
    });
    expect(worker.env.SCRATCHPAD.worker).toBe(`${worker.name}--audit`);
  });
});
