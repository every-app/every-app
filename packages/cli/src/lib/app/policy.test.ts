import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDeployInputs, type DeployInputs } from "./deployInputs";
import { appPolicyProblems, prepareAppBuildOutput } from "./policy";

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
    ["dev mode", (c: any) => (c.env.EVERYAPP_DEV = { type: "text", value: "1" }), /EVERYAPP_DEV/],
    [
      "no identity keys",
      (c: any) => delete c.env.EVERYAPP_IDENTITY_PUBLIC_KEYS,
      /EVERYAPP_IDENTITY_PUBLIC_KEYS isn't built in/,
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
      "a binding type it doesn't model (another Worker's workflow)",
      (c: any) =>
        (c.env.FLOW = {
          type: "workflow",
          name: "billing-run",
          className: "Run",
          scriptName: "billing-api",
        }),
      /FLOW is a workflow binding/,
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
      "a workflow export",
      (c: any) => (c.exports.Billing = { type: "workflow", name: "billing" }),
      /export Billing is a workflow/,
    ],
  ])("refuses %s", async (_case, change, problem) => {
    const config = await builtConfig();
    change(config);
    expect(appPolicyProblems(config, INPUTS).join("\n")).toMatch(problem);
  });

  it.each([
    ["a Hyperdrive config", { type: "hyperdrive", id: "h1" }],
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

  it("allows buckets named after the app's Worker", async () => {
    const config = await builtConfig();
    config["env"].R2 = { type: "r2", name: "every-acme-todo" };
    config["env"].UPLOADS = { type: "r2", name: "every-acme-todo--uploads" };
    expect(appPolicyProblems(config, INPUTS)).toEqual([]);
  });
});

describe("prepareAppBuildOutput", () => {
  it("lists every source map for upload and keeps the config valid", async () => {
    writeOutput(await builtConfig());

    await prepareAppBuildOutput({ cwd: appDir, inputs: INPUTS });

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
