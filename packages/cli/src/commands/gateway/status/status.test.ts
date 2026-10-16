/**
 * `everyapp gateway status`, all from the gateway's D1 and cf in a fake
 * account: the install row, the registry, the owner, certificates, running
 * deploys, and what to run when they disagree. Nothing goes to the gateway.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { acquireLease } from "@/lib/gateway/lease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { markDeployed, register } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { reportStatus } from "./index";

let account: FakeCloudflare;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const quick = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === "every-app-gateway")![0],
  );

beforeEach(async () => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  account = new FakeCloudflare();
  events = [];
  release = await openRelease(await buildGatewayRelease());
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
    ...quick,
  });
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

/** An app registered, uploaded (its Worker exists) and, unless `bind: false`, bound. */
async function deployed(appSlug: string, { bind = true } = {}) {
  const { plan } = await register(db(), {
    appSlug,
    name: appSlug,
    description: appSlug,
    manifest: { id: appSlug },
    appBaseDomain: "example.com",
    deployer: { actor: "dev@example.com", email: "dev@example.com" },
    organizationName: "Acme",
  });
  await markDeployed(db(), plan.app.id, {
    versionId: `${appSlug}-v1`,
    manifest: { id: appSlug },
    actor: "dev@example.com",
  });
  account.workers.set(plan.app.workerName!, {
    versions: [`${appSlug}-v1`],
    config: { name: plan.app.workerName, env: {} },
    secrets: {},
  });
  if (bind) {
    await reconcileGateway({
      cf: account.cf,
      out: out(),
      accountId: ACCOUNT_ID,
      interactive: false,
      cliVersion: "0.3.0",
      ...quick,
    });
  }
  return plan.app;
}

async function status() {
  events = [];
  await reportStatus({ cf: account.cf, account: { id: ACCOUNT_ID, name: "Acme" }, out: out() });
  return events.at(-1)!;
}

const fixCodes = (done: Record<string, any>) =>
  (done["data"]["fixes"] as Array<{ code: string }>).map((fix) => fix.code);

describe("gateway status", () => {
  it("reads the gateway, its apps and owner from D1 and cf, and asks nothing of the gateway", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await deployed("todo");
    // The gateway's first request makes it live.
    await new GatewayWorker(account).fetch("https://todo.example.com/");
    fetch.mockClear();

    const done = await status();

    expect(fetch).not.toHaveBeenCalled();
    expect(done).toMatchObject({
      type: "done",
      data: {
        gatewayUrl: "https://example.com",
        release: { version: "0.2.0", sha256: release.manifest.sha256 },
        versionId: account.workers.get("every-app-gateway")!.versions.at(-1),
        owner: null,
        claimed: false,
        inSync: true,
        apps: [
          {
            id: "todo",
            hostname: "todo.example.com",
            workerName: "every-acme-todo",
            status: "active",
            bound: true,
            deployedBy: "dev@example.com",
          },
        ],
        tls: true,
        certificates: [
          { host: "example.com", ready: true },
          { host: "todo.example.com", ready: true },
        ],
        leases: [],
      },
    });
    // No owner yet: the one thing to do.
    expect(done["data"]["fixes"]).toEqual([
      expect.objectContaining({ code: "NO_OWNER", run: "everyapp setup" }),
    ]);
    expect(done["message"]).toContain("Apps:     todo (active) · all bound");
  });

  it("says what to run when the registry, the install row and cf disagree", async () => {
    await deployed("todo");
    await deployed("chef");
    // Registered, never uploaded.
    await register(db(), {
      appSlug: "notes",
      name: "notes",
      description: "notes",
      manifest: { id: "notes" },
      appBaseDomain: "example.com",
      deployer: { actor: "dev@example.com", email: "dev@example.com" },
      organizationName: "Acme",
    });
    // Uploaded, but the gateway doesn't bind it yet.
    await deployed("board", { bind: false });
    // chef's Worker deleted by hand; a deploy running; the owner claimed.
    account.workers.delete("every-acme-chef");
    await acquireLease({ db: db(), id: "app:every-acme-todo", purpose: "app.deploy", heartbeatMs: 0 });
    new GatewayWorker(account).claim(
      (await mintSetupLink({ db: db(), gatewayUrl: "https://example.com" })).url,
    );

    const done = await status();

    expect(done["data"]).toMatchObject({
      owner: { email: "owner@example.com", organizationName: "Owner" },
      inSync: false,
    });
    expect(fixCodes(done).sort()).toEqual(
      ["APP_BINDING", "APP_NOT_UPLOADED", "APP_WORKER_MISSING", "BINDINGS_DIFFER", "DEPLOY_RUNNING"].sort(),
    );
    expect(done["data"]["fixes"]).toContainEqual(
      expect.objectContaining({ code: "BINDINGS_DIFFER", run: "everyapp gateway reconcile" }),
    );
    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({ id: "board", status: "binding", bound: false }),
    );

    // The gateway changed outside everyapp: that comes first.
    account.workers.get("every-app-gateway")!.versions.push("dashboard-1");
    expect(fixCodes(await status())).toContain("GATEWAY_CHANGED");
  });

  it("says when there is no gateway", async () => {
    const empty = new FakeCloudflare();
    events = [];
    await reportStatus({ cf: empty.cf, account: { id: ACCOUNT_ID, name: "Acme" }, out: out() });

    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: { deployed: false, fixes: [expect.objectContaining({ run: expect.stringContaining("everyapp setup") })] },
    });
  });
});
