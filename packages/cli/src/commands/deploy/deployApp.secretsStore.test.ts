/**
 * `everyapp deploy` and `delete --purge` of an app with a Secrets Store
 * secret (`resources.secretsStore`), end to end in the fake Cloudflare
 * account (test/fakeCloudflare.ts): the secret created through the
 * resource ledger as `<worker>--<binding>` in the account's store, from
 * the binding's value in `.everyapp/secrets.env` (never on argv, in output
 * or in the ledger), bound on the app's Worker and its helper, found again
 * and left as it is on a redeploy, refused when the name is someone
 * else's, stopped before anything is created without a store or a value,
 * and deleted with the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resourceSentinel } from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const WORKER = "every-acme-shop";
const HELPER = "every-acme-shop--billing";
const SECRET = "every-acme-shop--stripe-key";
const VALUE = "sk_test_never_on_argv_7c1f";

const SHOP: EveryAppCliManifest = {
  id: "shop",
  resources: { d1: ["DB"], secretsStore: [{ name: "STRIPE_KEY" }] },
  workers: [{ name: "billing" }],
};

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...seams,
  });
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-secrets-store-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  writeSecrets(`STRIPE_KEY=${VALUE}\n`);
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function writeSecrets(contents: string): void {
  fs.mkdirSync(path.join(appDir, ".everyapp"), { recursive: true });
  fs.writeFileSync(path.join(appDir, ".everyapp", "secrets.env"), contents);
}

function deploy(manifest: EveryAppCliManifest = SHOP) {
  account.apps.set(appDir, manifest);
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

const secretCalls = (action: string) =>
  account.cf.calls.filter(
    (call) => call.args[0] === "secrets-store" && call.args[1] === "secrets" && call.args[2] === action,
  );

const uploads = () =>
  account.deploys.filter((upload) => upload.workerName.startsWith(WORKER));

/** Whether anything this run made (cf's argv, its output events) holds the value. */
const valueLeaked = () =>
  account.cf.calls.some((call) => call.args.join(" ").includes(VALUE)) ||
  JSON.stringify(events).includes(VALUE);

describe("deploy of an app with a Secrets Store secret", () => {
  it("creates the secret from the secrets file, records it, and binds it on every Worker", async () => {
    const store = account.addSecretsStore();
    await deploy();

    expect(account.storeSecret(SECRET)).toMatchObject({
      storeId: store,
      value: VALUE,
      scopes: ["workers"],
    });
    const [helper, app] = uploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["STRIPE_KEY"]).toEqual({
        type: "secrets-store-secret",
        storeId: store,
        secretName: SECRET,
      });
    }
    // No placeholder of the build survives anywhere in what was uploaded.
    expect(JSON.stringify(app!.config)).not.toContain("sentinel");
    const secretId = account.storeSecret(SECRET)!.id;
    const owned = await readOwnedResources(registry(), WORKER);
    expect(owned).toContainEqual(
      expect.objectContaining({
        kind: "secrets-store-secret",
        binding: "STRIPE_KEY",
        name: SECRET,
        resourceId: `${store}/${secretId}`,
      }),
    );
    // The value went to cf in a body file only: never argv, output or the ledger.
    expect(valueLeaked()).toBe(false);
    expect(JSON.stringify(owned)).not.toContain(VALUE);
    const [create] = secretCalls("create");
    expect(create!.args.slice(0, 5)).toEqual(["secrets-store", "secrets", "create", store, "--body"]);
    expect(JSON.parse(Object.values(create!.files)[0]!)).toEqual([
      { name: SECRET, value: VALUE, scopes: ["workers"], comment: "Created by everyapp deploy" },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        step: "app.resources",
        message: `Created Secrets Store secret "${SECRET}".`,
      }),
    );
  });

  it("uses the store named everyapp when the account has several", async () => {
    account.addSecretsStore("default_secrets_store");
    const everyapp = account.addSecretsStore("everyapp");
    await deploy();
    expect(account.storeSecret(SECRET)?.storeId).toBe(everyapp);
  });

  it("finds its secret again on a redeploy, creates nothing, and leaves its value as it is", async () => {
    account.addSecretsStore();
    await deploy();
    writeSecrets("STRIPE_KEY=sk_test_rotated\n");
    await deploy();

    expect(secretCalls("create")).toHaveLength(1);
    expect(account.storeSecret(SECRET)?.value).toBe(VALUE);
    expect(uploads().at(-1)!.config["env"]["STRIPE_KEY"]["secretName"]).toBe(SECRET);

    // Nor does a redeploy need the value once the secret exists.
    writeSecrets("");
    await deploy();
    expect(secretCalls("create")).toHaveLength(1);
  });

  it("stops with SECRETS_STORE_MISSING before anything is created when the account has no store", async () => {
    const databases = account.databases.size;
    await expect(deploy()).rejects.toMatchObject({
      code: "SECRETS_STORE_MISSING",
      message: expect.stringContaining("Secrets Store → Create store"),
    });
    expect(account.databases.size).toBe(databases);
    expect(secretCalls("create")).toEqual([]);
    expect(uploads()).toEqual([]);
  });

  it("stops with SECRETS_STORE_VALUE_MISSING, naming the variable and the file, before anything is created", async () => {
    account.addSecretsStore();
    writeSecrets("OTHER=1\n");
    const databases = account.databases.size;
    await expect(deploy()).rejects.toMatchObject({
      code: "SECRETS_STORE_VALUE_MISSING",
      fix: "set STRIPE_KEY in .everyapp/secrets.env",
      message: expect.stringContaining("STRIPE_KEY needs its Secrets Store secret's value"),
    });
    expect(account.databases.size).toBe(databases);
    expect(secretCalls("create")).toEqual([]);
    expect(uploads()).toEqual([]);
  });

  it("refuses a secret of its name that no deploy of it recorded, before anything is uploaded", async () => {
    const store = account.addSecretsStore();
    account.secretsStores.get(store)!.secrets.set("theirs", { name: SECRET, value: "theirs", scopes: ["workers"] });

    await expect(deploy()).rejects.toMatchObject({
      code: "RESOURCE_NAME_TAKEN",
      message: expect.stringContaining(`A Secrets Store secret named "${SECRET}" already exists`),
    });
    expect(uploads()).toEqual([]);
    expect(secretCalls("create")).toEqual([]);
    expect(account.storeSecret(SECRET)?.value).toBe("theirs");
  });

  it("creates the secret again, with a warning, when the one it recorded was deleted", async () => {
    const store = account.addSecretsStore();
    await deploy();
    account.secretsStores.get(store)!.secrets.clear();
    events = [];
    await deploy();

    expect(account.storeSecret(SECRET)?.value).toBe(VALUE);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "RESOURCE_RECREATED" }),
    );
  });

  it("refuses a secret placeholder for a binding the manifest doesn't declare", async () => {
    account.addSecretsStore();
    account.editBuild = (config) => {
      config["env"]["SHADOW"] = {
        type: "secrets-store-secret",
        storeId: resourceSentinel("SHADOW"),
        secretName: resourceSentinel("SHADOW"),
      };
    };
    await expect(deploy()).rejects.toMatchObject({ code: "INSTALL_INPUTS_MISSING" });
    expect(uploads()).toEqual([]);
  });

  it("refuses a build that binds another store's secret or another name", async () => {
    const store = account.addSecretsStore();
    account.editBuild = (config) => {
      config["env"]["PAYROLL"] = {
        type: "secrets-store-secret",
        storeId: store,
        secretName: "payroll-api-key",
      };
    };
    await expect(deploy()).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        `PAYROLL is Secrets Store secret "payroll-api-key" in store "${store}", which isn't the one the deploy provisioned for a binding in resources.secretsStore`,
      ),
    });
    expect(uploads()).toEqual([]);
  });

  it("deletes the secret with the app on --purge, and keeps the store", async () => {
    const store = account.addSecretsStore();
    await deploy();
    const secretId = account.storeSecret(SECRET)!.id;
    const result = await removeApp({
      appId: "shop",
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: rebind,
    });

    expect(account.storeSecret(SECRET)).toBeUndefined();
    expect(account.secretsStores.has(store)).toBe(true);
    expect(result.purged?.removed).toContain(`Secrets Store secret "${SECRET}"`);
    expect(result.purged?.kept).toEqual([]);
    expect(secretCalls("delete")[0]!.args).toEqual([
      "secrets-store",
      "secrets",
      "delete",
      secretId,
      "--store-id",
      store,
      "--force",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.purge",
        status: "ok",
        data: expect.objectContaining({ kinds: expect.arrayContaining(["Secrets Store secret"]) }),
      }),
    );
  });

  it("purges an app whose secret was deleted by hand already", async () => {
    const store = account.addSecretsStore();
    await deploy();
    account.secretsStores.get(store)!.secrets.clear();
    const result = await removeApp({
      appId: "shop",
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: rebind,
    });
    expect(result.purged?.removed).not.toContain(`Secrets Store secret "${SECRET}"`);
    await expect(readOwnedResources(registry(), WORKER)).resolves.toEqual([]);
  });
});
