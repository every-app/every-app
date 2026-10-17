import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  everyAppAuxiliaryWorker,
  everyAppWorker,
} from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDeployInputs, type DeployInputs } from "./deployInputs";
import {
  appPolicyProblems,
  helperPolicyProblems,
  prepareAppBuildOutput,
} from "./policy";

const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";

const INPUTS: DeployInputs = {
  workerName: "every-acme-todo",
  organizationId: "org-1",
  gatewayUrl: "https://apps.example.com",
  identityIssuer: "https://apps.example.com",
  identityPublicKeys: [PUBLIC_KEY],
  resources: {
    d1: { DB: { name: "every-acme-todo", id: "11111111-2222-4333-8444-555555555555" } },
    kv: { KV: { id: "0123456789abcdef0123456789abcdef" } },
  },
};

const MANIFEST = {
  id: "todo",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
    workflows: [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }],
  },
} as const;

let appDir: string;

/**
 * The worker.config.json `cf build` writes for an app: everyAppWorker()'s
 * production definition, with the bundle manifest instead of the entrypoint.
 */
async function builtConfig(): Promise<Record<string, any>> {
  await writeDeployInputs(appDir, INPUTS);
  const { entrypoint: _entrypoint, ...worker } = everyAppWorker({
    manifest: MANIFEST,
    entrypoint: "./src/entry.worker.ts",
    ctx: { mode: "production" },
    root: appDir,
  });
  return {
    ...structuredClone(worker),
    manifest: { type: "partial", mainModule: "index.js", modules: {} },
  };
}

function writeOutput(config: object, mode = "production"): void {
  const dir = path.join(appDir, ".cloudflare/output/v0");
  fs.mkdirSync(path.join(dir, "workers/default/bundle/assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ buildContext: { isPreview: false, mode } }),
  );
  fs.writeFileSync(
    path.join(dir, "workers/default/worker.config.json"),
    JSON.stringify(config),
  );
  fs.writeFileSync(path.join(dir, "workers/default/bundle/index.js"), "");
  fs.writeFileSync(path.join(dir, "workers/default/bundle/index.js.map"), "{}");
  fs.writeFileSync(path.join(dir, "workers/default/bundle/assets/a.js.map"), "{}");
}

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-policy-"));
});
afterEach(() => fs.rmSync(appDir, { recursive: true, force: true }));

describe("appPolicyProblems", () => {
  it("accepts what everyAppWorker() builds for production", async () => {
    expect(appPolicyProblems(await builtConfig(), INPUTS)).toEqual([]);
  });

  it("accepts cron schedules", async () => {
    const config = await builtConfig();
    config["triggers"] = [{ type: "scheduled", schedule: "17 */6 * * *" }];
    expect(appPolicyProblems(config, INPUTS)).toEqual([]);
  });

  it.each([
    ["another name", (c: any) => (c.name = "every-other-todo"), /its name is "every-other-todo"/],
    ["workers.dev", (c: any) => (c.workersDev = true), /workersDev/],
    ["preview URLs", (c: any) => delete c.previewUrls, /previewUrls/],
    ["its own domain", (c: any) => (c.domains = ["todo.example.com"]), /declares domains/],
    [
      "a route",
      (c: any) => (c.triggers = [{ type: "fetch", pattern: "todo.example.com/*" }]),
      /declares routes/,
    ],
    [
      "a queue consumer",
      (c: any) => (c.triggers = [{ type: "queue", queue: "every-acme-billing-jobs" }]),
      /declares a trigger of type "queue"/,
    ],
    [
      "an email trigger",
      (c: any) => (c.triggers = [{ type: "email", addresses: ["*@example.com"] }]),
      /declares a trigger of type "email"/,
    ],
    ["dev mode", (c: any) => (c.env.EVERYAPP_DEV = { type: "text", value: "1" }), /EVERYAPP_DEV/],
    [
      "no identity keys",
      (c: any) => delete c.env.EVERYAPP_IDENTITY_PUBLIC_KEYS,
      /EVERYAPP_IDENTITY_PUBLIC_KEYS isn't built in/,
    ],
    [
      "no audience",
      (c: any) => delete c.env.EVERYAPP_AUDIENCE,
      /EVERYAPP_AUDIENCE isn't the Worker's name \("every-acme-todo"\)/,
    ],
    [
      "another Worker's audience",
      (c: any) => (c.env.EVERYAPP_AUDIENCE = { type: "text", value: "every-beta-todo" }),
      /EVERYAPP_AUDIENCE isn't the Worker's name/,
    ],
    [
      "another Worker",
      (c: any) => (c.env.BILLING = { type: "worker", worker: "billing-api" }),
      /BILLING binds Worker "billing-api"/,
    ],
    [
      "the gateway's default entrypoint",
      (c: any) => delete c.env.EVERY_APP_GATEWAY.exportName,
      /EVERY_APP_GATEWAY binds Worker/,
    ],
    [
      "another Worker's Durable Object",
      (c: any) => (c.env.USER_SYNC.worker = "every-other-todo"),
      /USER_SYNC binds another Worker's Durable Object/,
    ],
    [
      "a D1 database it didn't provision",
      (c: any) => (c.env.DB.id = "99999999-2222-4333-8444-555555555555"),
      /DB isn't a D1 database the deploy provisioned/,
    ],
    [
      "a D1 database cf would create",
      (c: any) => delete c.env.DB.id,
      /DB isn't a D1 database/,
    ],
    [
      "a KV namespace it didn't provision",
      (c: any) => (c.env.KV.id = "fedcba9876543210fedcba9876543210"),
      /KV isn't a KV namespace/,
    ],
    [
      "someone else's bucket",
      (c: any) => (c.env.R2 = { type: "r2", name: "company-backups" }),
      /R2 is bucket "company-backups"/,
    ],
    [
      // App `todo-archive`'s bucket, which starts with this app's Worker name.
      "another app's bucket with its name as a prefix",
      (c: any) => (c.env.R2 = { type: "r2", name: "every-acme-todo-archive" }),
      /R2 is bucket "every-acme-todo-archive"/,
    ],
    [
      "another Worker's Workflow",
      (c: any) =>
        (c.env.FLOW = {
          type: "workflow",
          name: "billing-run",
          worker: "billing-api",
          exportName: "Run",
        }),
      /FLOW binds Workflow "billing-run" of Worker "billing-api"/,
    ],
    [
      // App `todo-archive`'s name, though the Worker would define it.
      "a Workflow binding named like another app's",
      (c: any) => (c.env.RANK_CHECK.name = "every-acme-todo-archive--rank-check"),
      /RANK_CHECK binds Workflow "every-acme-todo-archive--rank-check"/,
    ],
    [
      "deleting a Durable Object's data it didn't drop",
      (c: any) => (c.exports.UserSyncDO = { type: "durable-object", state: "deleted" }),
      /UserSyncDO is marked deleted/,
    ],
    [
      "moving a Durable Object's data to another Worker",
      (c: any) =>
        (c.exports.UserSyncDO = {
          type: "durable-object",
          state: "transferred",
          transferredTo: "every-other-todo",
        }),
      /would move its data to Worker "every-other-todo"/,
    ],
    [
      "taking another Worker's Durable Object data",
      (c: any) =>
        (c.exports.Stolen = {
          type: "durable-object",
          state: "expecting-transfer",
          storage: "sqlite",
          transferFrom: "every-other-todo",
        }),
      /Stolen would take the data of Worker "every-other-todo"/,
    ],
    [
      "a Workflow export not named after it",
      (c: any) => (c.exports.Billing = { type: "workflow", name: "billing" }),
      /Workflow Billing is named "billing"/,
    ],
  ])("refuses %s", async (_case, change, problem) => {
    const config = await builtConfig();
    change(config);
    expect(appPolicyProblems(config, INPUTS).join("\n")).toMatch(problem);
  });

  it.each([
    ["a dispatch namespace", { type: "dispatch-namespace", namespace: "n" }],
    ["a private network", { type: "vpc-service", serviceId: "s1" }],
    ["a secrets store", { type: "secrets-store-secret", storeId: "s", secretName: "x" }],
    ["shared rate-limit counters", { type: "rate-limit", namespace: "4180", simple: { limit: 1, period: 60 } }],
    ["Workers AI directly", { type: "ai" }],
  ])("refuses %s, a binding type apps can't use", async (_case, binding) => {
    const config = await builtConfig();
    config["env"].EXTRA = binding;
    expect(appPolicyProblems(config, INPUTS).join("\n")).toContain(
      `EXTRA is a ${binding.type} binding`,
    );
  });

  it("deletes a Durable Object class only when the deploy dropped it", async () => {
    const config = await builtConfig();
    config["exports"].OldClass = { type: "durable-object", state: "deleted" };
    expect(
      appPolicyProblems(config, { ...INPUTS, deletedDurableObjects: ["OldClass"] }),
    ).toEqual([]);
    expect(appPolicyProblems(config, INPUTS).join("\n")).toMatch(
      /OldClass is marked deleted/,
    );
  });

  it("allows only the Hyperdrive configs the deploy provisioned", async () => {
    const config = await builtConfig();
    config["env"].HYPERDRIVE = { type: "hyperdrive", id: "hd-1" };
    expect(appPolicyProblems(config, INPUTS).join("\n")).toContain(
      "HYPERDRIVE isn't a Hyperdrive config the deploy provisioned",
    );
    expect(
      appPolicyProblems(config, {
        ...INPUTS,
        resources: { ...INPUTS.resources, hyperdrive: { HYPERDRIVE: { id: "hd-1" } } },
      }),
    ).toEqual([]);
  });

  it("allows buckets named after the app's Worker", async () => {
    const config = await builtConfig();
    config["env"].R2 = { type: "r2", name: "every-acme-todo" };
    config["env"].UPLOADS = { type: "r2", name: "every-acme-todo--uploads" };
    expect(appPolicyProblems(config, INPUTS)).toEqual([]);
  });

  describe("with resources.r2", () => {
    const WITH_R2: DeployInputs = {
      ...INPUTS,
      resources: {
        ...INPUTS.resources,
        r2: {
          R2: { name: "every-acme-todo" },
          MEDIA: { name: "every-acme-todo--media" },
        },
      },
    };

    it("accepts the declared buckets everyAppWorker() binds, on the app and its helpers", async () => {
      const manifest = {
        ...MANIFEST,
        resources: { ...MANIFEST.resources, r2: ["R2", "MEDIA"] },
        workers: [{ name: "api", binding: "API" }],
      } as const;
      await writeDeployInputs(appDir, WITH_R2);
      const build = (config: Record<string, any>) => {
        const { entrypoint: _entrypoint, ...worker } = config;
        return structuredClone(worker);
      };
      const app = build(
        everyAppWorker({
          manifest,
          entrypoint: "./src/entry.worker.ts",
          ctx: { mode: "production" },
          root: appDir,
        }),
      );
      const helper = build(
        everyAppAuxiliaryWorker({
          manifest,
          worker: "api",
          entrypoint: "./src/api.ts",
          ctx: { mode: "production" },
          root: appDir,
        }),
      );
      for (const config of [app, helper]) {
        expect(config["env"]).toMatchObject({
          R2: { type: "r2", name: "every-acme-todo" },
          MEDIA: { type: "r2", name: "every-acme-todo--media" },
        });
      }
      const inputs = { ...WITH_R2, helperWorkers: ["every-acme-todo--api"] };
      expect(appPolicyProblems(app, inputs)).toEqual([]);
      expect(helperPolicyProblems(helper, "every-acme-todo--api", inputs)).toEqual([]);
    });

    it("refuses a bucket the manifest doesn't declare, even one named after the Worker", async () => {
      const config = await builtConfig();
      config["env"].UPLOADS = { type: "r2", name: "every-acme-todo--uploads" };
      config["env"].BACKUPS = { type: "r2", name: "company-backups" };
      expect(appPolicyProblems(config, WITH_R2)).toEqual([
        'UPLOADS is bucket "every-acme-todo--uploads", which isn\'t one of the app\'s buckets in resources.r2 (every-acme-todo, every-acme-todo--media)',
        'BACKUPS is bucket "company-backups", which isn\'t one of the app\'s buckets in resources.r2 (every-acme-todo, every-acme-todo--media)',
      ]);
    });

    it("keeps accepting a bucket bound by hand when the manifest declares none", async () => {
      // chef's and OpenSEO's `bindings.r2({ name: worker.name })`.
      const config = await builtConfig();
      config["env"].BUCKET = { type: "r2", name: "every-acme-todo" };
      const none = { ...INPUTS, resources: { ...INPUTS.resources, r2: {} } };
      expect(appPolicyProblems(config, none)).toEqual([]);
      expect(appPolicyProblems(config, INPUTS)).toEqual([]);
    });
  });
});

describe("prepareAppBuildOutput", () => {
  it("lists every source map for upload and keeps the config valid", async () => {
    writeOutput(await builtConfig());

    // The Workflows cf will create or update for the Worker.
    await expect(
      prepareAppBuildOutput({ cwd: appDir, inputs: INPUTS }),
    ).resolves.toEqual({
      workflows: ["every-acme-todo--rank-check"],
      helperWorkflows: {},
    });

    const written = JSON.parse(
      fs.readFileSync(
        path.join(appDir, ".cloudflare/output/v0/workers/default/worker.config.json"),
        "utf8",
      ),
    );
    expect(written.manifest.modules).toEqual({
      "assets/a.js.map": { type: "sourcemap" },
      "index.js.map": { type: "sourcemap" },
    });
  });

  it("refuses with every problem at once", async () => {
    const config = await builtConfig();
    config["workersDev"] = true;
    config["env"].EVERYAPP_DEV = { type: "text", value: "1" };
    writeOutput(config);

    await expect(
      prepareAppBuildOutput({ cwd: appDir, inputs: INPUTS }),
    ).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringMatching(/workersDev[\s\S]*EVERYAPP_DEV/),
    });
  });

  it("refuses a development build", async () => {
    writeOutput(await builtConfig(), "development");
    await expect(
      prepareAppBuildOutput({ cwd: appDir, inputs: INPUTS }),
    ).rejects.toThrow(/isn't a production build/);
  });
});

describe("helper Workers", () => {
  const SEO = {
    id: "todo",
    resources: {
      d1: ["DB"],
      kv: ["KV"],
      durableObjects: [
        { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
      ],
      workflows: [
        { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
      ],
    },
    workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
  } as const;
  const HELPER = "every-acme-todo--audit";
  const WITH_HELPER = { ...INPUTS, helperWorkers: [HELPER] };

  async function builtPair() {
    await writeDeployInputs(appDir, INPUTS);
    const options = { manifest: SEO, ctx: { mode: "production" }, root: appDir } as const;
    const { entrypoint: _app, ...app } = everyAppWorker({
      ...options,
      entrypoint: "./src/entry.worker.ts",
    });
    const { entrypoint: _helper, ...helper } = everyAppAuxiliaryWorker({
      ...options,
      worker: "audit",
      entrypoint: "./src/audit.ts",
    });
    const bundle = { type: "partial", mainModule: "index.js", modules: {} };
    return {
      app: { ...structuredClone(app), manifest: bundle } as Record<string, any>,
      helper: { ...structuredClone(helper), manifest: bundle } as Record<string, any>,
    };
  }

  function writeHelper(config: object, directory = HELPER): void {
    const dir = path.join(appDir, ".cloudflare/output/v0/workers", directory);
    fs.mkdirSync(path.join(dir, "bundle"), { recursive: true });
    fs.writeFileSync(path.join(dir, "worker.config.json"), JSON.stringify(config));
    fs.writeFileSync(path.join(dir, "bundle/index.js"), "");
  }

  it("lets the app bind its helper and the classes the helper defines", async () => {
    const { app, helper } = await builtPair();
    expect(appPolicyProblems(app, WITH_HELPER)).toEqual([]);
    expect(helperPolicyProblems(helper, HELPER, WITH_HELPER)).toEqual([]);
  });

  it.each([
    ["a public helper", (c: any) => (c.workersDev = true), /workersDev/],
    [
      "a helper that binds the app's Worker",
      (c: any) => (c.env.APP = { type: "worker", worker: "every-acme-todo" }),
      /APP binds Worker "every-acme-todo"/,
    ],
    [
      "a helper that binds another app's Durable Object",
      (c: any) =>
        (c.env.SCRATCHPAD.worker = "every-acme-todo-archive--audit"),
      /SCRATCHPAD binds another Worker's Durable Object/,
    ],
    [
      "a helper's Workflow named for another app",
      (c: any) => (c.exports.SiteAuditWorkflow.name = "every-acme-other--x"),
      /Workflow SiteAuditWorkflow is named "every-acme-other--x"/,
    ],
  ])("refuses %s", async (_case, change, problem) => {
    const { helper } = await builtPair();
    change(helper);
    expect(helperPolicyProblems(helper, HELPER, WITH_HELPER).join("\n")).toMatch(
      problem,
    );
  });

  it("checks every Worker in the build, and that each declared helper is there", async () => {
    const { app, helper } = await builtPair();
    writeOutput(app);
    writeHelper(helper);
    // Each Worker's Workflows: cf creates a helper's as it deploys that helper.
    await expect(
      prepareAppBuildOutput({ cwd: appDir, inputs: WITH_HELPER }),
    ).resolves.toEqual({
      workflows: [],
      helperWorkflows: { [HELPER]: ["every-acme-todo--site-audit"] },
    });

    writeHelper({ ...helper, name: "every-acme-todo--crawler" }, "crawler");
    await expect(
      prepareAppBuildOutput({ cwd: appDir, inputs: WITH_HELPER }),
    ).rejects.toThrow(/Worker "every-acme-todo--crawler" that everyapp.config.ts doesn't declare/);

    fs.rmSync(path.join(appDir, ".cloudflare/output/v0/workers"), { recursive: true });
    writeOutput(app);
    await expect(
      prepareAppBuildOutput({ cwd: appDir, inputs: WITH_HELPER }),
    ).rejects.toThrow(/has no Worker every-acme-todo--audit/);
  });
});
