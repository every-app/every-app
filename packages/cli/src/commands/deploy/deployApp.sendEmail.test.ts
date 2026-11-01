/**
 * `everyapp deploy` (and `everyapp release`) of an app declaring
 * Cloudflare's `send_email` binding (`resources.sendEmail`), end to end in
 * the fake Cloudflare account (test/fakeCloudflare.ts): nothing is
 * provisioned, the binding lands on the app's Worker and its helper with
 * the manifest's addresses, and the policy refuses one the manifest
 * doesn't declare, under another name, or with other addresses, before
 * anything is uploaded (the upload itself checks no address).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { bundleApp } from "../release/bundleApp";
import { deployApp } from "./deployApp";

const WORKER = "every-acme-notifier";
const HELPER = "every-acme-notifier--digest";

const NOTIFIER: EveryAppCliManifest = {
  id: "notifier",
  resources: {
    d1: ["DB"],
    sendEmail: [
      {
        name: "EMAIL",
        allowedSenderAddresses: ["noreply@example.com", "alerts@example.com"],
        allowedDestinationAddresses: ["ops@example.com"],
      },
      {
        name: "PAGER",
        allowedSenderAddresses: ["alerts@example.com"],
        destinationAddress: "oncall@example.com",
      },
    ],
  },
  workers: [{ name: "digest" }],
};

const EMAIL = {
  type: "send-email",
  allowedSenderAddresses: ["noreply@example.com", "alerts@example.com"],
  allowedDestinationAddresses: ["ops@example.com"],
};
const PAGER = {
  type: "send-email",
  allowedSenderAddresses: ["alerts@example.com"],
  destinationAddress: "oncall@example.com",
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-send-email-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function deploy(manifest: EveryAppCliManifest = NOTIFIER) {
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

const uploads = () => account.deploys.filter((upload) => upload.workerName.startsWith(WORKER));

/** Deploying stops at the policy with `problem`, and nothing of the app is uploaded. */
async function expectRefused(manifest: EveryAppCliManifest, problem: string) {
  await expect(deploy(manifest)).rejects.toMatchObject({
    code: "APP_POLICY",
    message: expect.stringContaining(problem),
  });
  expect(uploads()).toEqual([]);
}

describe("deploy of an app with Cloudflare's send_email binding", () => {
  it("binds each declared binding, with its addresses, on the app's Worker and its helper, and provisions nothing", async () => {
    const before = account.cf.calls.length;
    await deploy();

    const [helper, app] = uploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["EMAIL"]).toEqual(EMAIL);
      expect(upload.config["env"]["PAGER"]).toEqual(PAGER);
    }
    // No cf command of its own: the binding is the whole of it.
    const commands = account.cf.calls.slice(before).map((call) => call.args[0]);
    expect(commands).not.toContain("email-sending");
    expect(commands).not.toContain("email-routing");
    expect(
      (await readOwnedResources(registry(), WORKER)).map((resource) => resource.kind).sort(),
    ).toEqual(["d1", "worker", "worker"]);
  });

  it("binds a declared binding with its senders and no destinations", async () => {
    await deploy({
      id: "notifier",
      resources: { sendEmail: [{ name: "EMAIL", allowedSenderAddresses: ["noreply@example.com"] }] },
    });

    const [app] = uploads();
    expect(app!.config["env"]["EMAIL"]).toEqual({
      type: "send-email",
      allowedSenderAddresses: ["noreply@example.com"],
    });
  });

  it("refuses a send-email binding the manifest doesn't declare", async () => {
    account.editBuild = (config) => {
      config["env"]["EMAIL"] = { type: "send-email" };
    };
    await expectRefused(
      { id: "notifier", resources: { d1: ["DB"] } },
      "EMAIL is a send-email binding that everyapp.config.ts doesn't declare in resources.sendEmail",
    );
  });

  it("refuses one under a name the manifest doesn't declare", async () => {
    account.editBuild = (config) => {
      config["env"]["MAILER"] = config["env"]["EMAIL"];
      delete config["env"]["EMAIL"];
    };
    await expectRefused(
      NOTIFIER,
      "MAILER is a send-email binding that everyapp.config.ts doesn't declare in resources.sendEmail (it declares EMAIL, PAGER)",
    );
  });

  it.each([
    [
      "another sender",
      (env: Record<string, any>) => {
        env["EMAIL"].allowedSenderAddresses = ["noreply@example.com", "ceo@example.com"];
      },
      "EMAIL isn't the send-email binding resources.sendEmail declares: allowedSenderAddresses is [ceo@example.com, noreply@example.com], not [alerts@example.com, noreply@example.com]",
    ],
    [
      "no sender list",
      (env: Record<string, any>) => {
        delete env["EMAIL"].allowedSenderAddresses;
      },
      "EMAIL isn't the send-email binding resources.sendEmail declares: allowedSenderAddresses is none, not [alerts@example.com, noreply@example.com]",
    ],
    [
      "another destination",
      (env: Record<string, any>) => {
        env["PAGER"].destinationAddress = "someone@example.net";
      },
      "PAGER isn't the send-email binding resources.sendEmail declares: destinationAddress is someone@example.net, not oncall@example.com",
    ],
    [
      "the one destination as a list",
      (env: Record<string, any>) => {
        env["PAGER"].destinationAddress = ["oncall@example.com"];
      },
      "PAGER isn't the send-email binding resources.sendEmail declares: destinationAddress is [oncall@example.com], not oncall@example.com",
    ],
    [
      "a list of destinations in place of the one",
      (env: Record<string, any>) => {
        delete env["PAGER"].destinationAddress;
        env["PAGER"].allowedDestinationAddresses = ["oncall@example.com"];
      },
      "PAGER isn't the send-email binding resources.sendEmail declares: destinationAddress is none, not oncall@example.com; allowedDestinationAddresses is [oncall@example.com], not none",
    ],
  ])("refuses a declared binding built with %s", async (_case, edit, problem) => {
    account.editBuild = (config) => edit(config["env"]);
    await expectRefused(NOTIFIER, problem);
  });

  it("accepts the declared lists in another order", async () => {
    account.editBuild = (config) => {
      config["env"]["EMAIL"].allowedSenderAddresses = ["alerts@example.com", "noreply@example.com"];
    };
    await deploy();
    expect(uploads().map((upload) => upload.workerName)).toEqual([HELPER, WORKER]);
  });
});

describe("release of an app with Cloudflare's send_email binding", () => {
  it("checks the build against the manifest it packs", async () => {
    account.apps.set(appDir, NOTIFIER);
    const packed = await bundleApp({
      cwd: appDir,
      manifest: NOTIFIER,
      outFile: "everyapp-release.tar.gz",
      out: out(),
      createCf: () => account.cf,
      installDeps: async () => undefined,
    });
    expect(fs.existsSync(packed.tarball)).toBe(true);

    account.editBuild = (config) => {
      config["env"]["EMAIL"].allowedSenderAddresses = ["ceo@example.com"];
    };
    await expect(
      bundleApp({
        cwd: appDir,
        manifest: NOTIFIER,
        outFile: "everyapp-release.tar.gz",
        out: out(),
        createCf: () => account.cf,
        installDeps: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining("allowedSenderAddresses is [ceo@example.com]"),
    });
  });
});
