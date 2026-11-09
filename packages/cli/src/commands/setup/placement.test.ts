/**
 * `--placement`: where the Gateway Worker runs, chosen once and kept. Every
 * Gateway upload goes through applyGateway, so these drive the real paths
 * (`setup`, `update` with a newer release and with the same one, a
 * reconcile) against a fake Cloudflare account, and read what was uploaded.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { readInstall, writeInstall } from "@/lib/gateway/install";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { openRelease } from "@/lib/gateway/release";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { runGatewayDeploy, runSetup, type GatewayDeployFlags, type SetupDeps, type SetupFlags } from "./runSetup";

const GW = "apps.example.com";
const WORKER = "every-app-gateway";

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let home: string;
let events: any[];

beforeEach(async () => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("CI", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  tarball = await buildGatewayRelease();
  events = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const sink = (): EventSink => createNdjsonSink((line) => events.push(JSON.parse(line)));

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    createCf: () => account.cf,
    openRelease: () => openRelease(tarball),
    source: () => releaseSource(tarball),
    interactive: false,
    prompts: {
      accessInFront: async () => false,
      pickZone: async () => {
        throw new Error("asked a person");
      },
      gatewayAddress: async () => {
        throw new Error("asked a person");
      },
    },
    openBrowser: async () => undefined,
    cliVersion: "0.3.0",
    seams: {
      sleep: async () => undefined,
      leaseWaitMs: 0,
      certificates: {
        probe: async () => ({ answered: true, status: 200, access: false }),
        sleep: async () => undefined,
      },
      fetch: worker.fetch,
      owner: {
        sleep: async () => {
          const link = events.findLast((event) => event.type === "action_required" && event.action === "claim_owner");
          try {
            if (link) worker.claim(link.data.url);
          } catch {
            // Claimed already.
          }
        },
        timeoutMs: 60_000,
      },
    },
    ...overrides,
  };
}

const setup = (flags: SetupFlags = {}) =>
  runSetup({ json: true, "no-access": true, domain: GW, ...flags }, sink(), deps());

const update = (flags: GatewayDeployFlags = {}, overrides: Partial<SetupDeps> = {}) =>
  runGatewayDeploy({ json: true, ...flags }, sink(), deps(overrides));

/** `update` with a newer release than the live one. */
async function updateToNewer(flags: GatewayDeployFlags = {}, builtAt = "2026-10-31T00:00:00.000Z") {
  const newer = await buildGatewayRelease({ builtAt });
  return update(flags, { openRelease: () => openRelease(newer), source: () => releaseSource(newer) });
}

const gatewayD1 = () =>
  cfD1Database(account.cf, [...account.databases].find(([, d]) => d.name === WORKER)![0]);
/** The placement in the last upload's Build Output (cf turns it into what it sends; `off` it sends as nothing). */
const uploaded = () => account.workers.get(WORKER)!.config["placement"];
const recorded = async () => (await readInstall(gatewayD1()))?.placement;
const uploads = () => account.deploys.length;

describe("update --placement", () => {
  it("uploads the same release again with smart placement, and records it", async () => {
    await setup();
    const before = uploads();

    await expect(update({ placement: "smart" })).resolves.toMatchObject({ gateway: "repaired" });

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ mode: "smart" });
    await expect(recorded()).resolves.toBe("smart");
  });

  it("places the Gateway near a cloud region", async () => {
    await setup();

    await update({ placement: "aws:ap-south-1" });

    expect(uploaded()).toEqual({ region: "aws:ap-south-1" });
    await expect(recorded()).resolves.toBe("aws:ap-south-1");
  });

  it("takes the choice with a newer release too", async () => {
    await setup();

    await expect(updateToNewer({ placement: "smart" })).resolves.toMatchObject({ gateway: "upgraded" });

    expect(uploaded()).toEqual({ mode: "smart" });
    await expect(recorded()).resolves.toBe("smart");
  });

  it("clears it with off, and remembers that", async () => {
    await setup();
    await update({ placement: "smart" });

    await update({ placement: "off" });

    expect(uploaded()).toEqual({ mode: "off" });
    await expect(recorded()).resolves.toBe("off");
    await updateToNewer();
    expect(uploaded()).toEqual({ mode: "off" });
  });

  it("reads the value the way a person typed it", async () => {
    await setup();

    await update({ placement: " SMART " });

    expect(uploaded()).toEqual({ mode: "smart" });
    await expect(recorded()).resolves.toBe("smart");
  });

  it("uploads when asked again: the row can't say what the Worker really has", async () => {
    await setup();
    await update({ placement: "smart" });
    // An upload from an older everyapp, say an app pinned to one: no placement, and the row untouched.
    delete account.workers.get(WORKER)!.config["placement"];
    const before = uploads();

    await update({ placement: "smart" });

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ mode: "smart" });
  });

  it("uploads for off too, though none was ever recorded: it may have been set in the dashboard", async () => {
    await setup();
    const before = uploads();

    await update({ placement: "off" });

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ mode: "off" });
    await expect(recorded()).resolves.toBe("off");
  });

  it("leaves a Gateway alone with no --placement, once it is up to date", async () => {
    await setup();
    await update({ placement: "smart" });
    const before = uploads();

    await expect(update()).resolves.toMatchObject({ gateway: "up-to-date" });

    expect(uploads()).toBe(before);
  });

  it("uploads for a different placement than the one recorded", async () => {
    await setup();
    await update({ placement: "smart" });
    const before = uploads();

    await update({ placement: "gcp:europe-west1" });

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ region: "gcp:europe-west1" });
  });

  it("says what it is doing", async () => {
    await setup();
    events = [];

    await update({ placement: "smart" });

    expect(events).toContainEqual(
      expect.objectContaining({
        step: "setup.gateway",
        status: "start",
        message: expect.stringContaining("for --placement smart"),
      }),
    );
  });

  it("refuses a value it doesn't know before asking Cloudflare anything", async () => {
    await setup();
    const calls = account.cf.calls.length;
    const before = uploads();

    await expect(update({ placement: "near-my-users" })).rejects.toMatchObject({ code: "INVALID_PLACEMENT" });

    expect(account.cf.calls).toHaveLength(calls);
    expect(uploads()).toBe(before);
    await expect(recorded()).resolves.toBeNull();
  });

  it.each([
    ["--placement smart", ["--placement", "smart"]],
    ["--placement=smart", ["--placement=smart"]],
  ])("doesn't offer a plain update after a dropped network: only the rerun keeps %s", async (spelled, flag) => {
    await setup();
    const dropped = await account.cf
      .override(["fail-with-network-drop"], { exitCode: 1, stderr: "fetch failed" })
      .run({ plane: "account", mode: "text", args: ["fail-with-network-drop"] })
      .catch((error: unknown) => error);
    const flaky: CfRunner = {
      run: (call) => {
        const args = typeof call.args === "function" ? null : call.args;
        return call.cliCf && (args === null || args[0] === "deploy") ? Promise.reject(dropped) : account.cf.run(call);
      },
      start: (call) => account.cf.start(call),
    };
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "update", ...flag, "--json"];
    try {
      const failure = (await update({ placement: "smart" }, { createCf: () => flaky }).catch(
        (error: unknown) => error,
      )) as { code: string; rerun: string; rerunNote: string };

      expect(failure.code).toBe("UPLOAD_NETWORK_FAILED");
      expect(failure.rerun).toContain(spelled);
      expect(failure.rerunNote).not.toContain("update brings the Gateway in step");
    } finally {
      process.argv = argv;
    }
  });

  it("keeps the choice in the rerun when the Gateway isn't finished installing", async () => {
    await setup();
    account.database(WORKER).sqlite.exec("UPDATE _everyapp_install SET live_version_id = NULL");

    await expect(update({ placement: "smart" })).rejects.toMatchObject({
      code: "GATEWAY_NOT_INSTALLED",
      rerun: "pnpm everyapp setup --placement smart",
    });
    await expect(update()).rejects.toMatchObject({ rerun: "pnpm everyapp setup" });
  });

  it("records the choice with the upload, though cf stops after it", async () => {
    await setup();
    const before = uploads();
    account.afterUpload = () => ({ exitCode: 1, stderr: "┌ Error\n│ Could not publish the hostname\n└\n" });

    await expect(update({ placement: "smart" })).rejects.toThrow("Could not publish the hostname");

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ mode: "smart" });
    await expect(recorded()).resolves.toBe("smart");
  });

  it("keeps the old choice when the upload fails, so the next run still has it", async () => {
    await setup();
    await update({ placement: "smart" });
    account.failNextDeploy = "Placement region not found";

    await expect(update({ placement: "aws:mars-1" })).rejects.toThrow();

    await expect(recorded()).resolves.toBe("smart");
    await updateToNewer();
    expect(uploaded()).toEqual({ mode: "smart" });
  });
});

describe("a placement already chosen", () => {
  it("is kept by a later update with no flag", async () => {
    await setup();
    await update({ placement: "aws:ap-south-1" });

    await expect(updateToNewer()).resolves.toMatchObject({ gateway: "upgraded" });

    expect(uploaded()).toEqual({ region: "aws:ap-south-1" });
    await expect(recorded()).resolves.toBe("aws:ap-south-1");
  });

  it("is kept across several later updates", async () => {
    await setup();
    await update({ placement: "smart" });

    await updateToNewer({}, "2026-10-31T00:00:00.000Z");
    await updateToNewer({}, "2026-11-01T00:00:00.000Z");

    expect(uploaded()).toEqual({ mode: "smart" });
  });

  it("is kept by the reconcile an app's deploy or delete runs", async () => {
    await setup();
    await update({ placement: "smart" });
    const before = uploads();
    const install = (await readInstall(gatewayD1()))!;
    const database = [...account.databases].find(([, d]) => d.name === WORKER)![0];

    await reconcileGateway({
      cf: account.cf,
      out: sink(),
      accountId: ACCOUNT_ID,
      databaseId: database,
      openRelease: () => openRelease(tarball),
      interactive: false,
      cliVersion: "0.3.0",
      force: true,
      sleep: async () => undefined,
      leaseWaitMs: 0,
    });

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ mode: "smart" });
    await expect(recorded()).resolves.toBe("smart");
    expect((await readInstall(gatewayD1()))?.liveVersionId).not.toBe(install.liveVersionId);
  });

  it("is kept by --redeploy", async () => {
    await setup();
    await update({ placement: "smart" });
    const before = uploads();

    await update({ redeploy: true });

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ mode: "smart" });
  });

  it("survives a write that names no placement", async () => {
    await setup();
    await update({ placement: "smart" });
    const { placement: _left, ...install } = (await readInstall(gatewayD1()))!;

    await writeInstall(gatewayD1(), { ...install, liveVersionId: "another-version" });

    await expect(recorded()).resolves.toBe("smart");
  });

  it("belongs to one Gateway: a named one beside it has its own", async () => {
    await setup({ placement: "smart" });
    const nobody = { seams: { ...deps().seams!, owner: { sleep: async () => undefined, timeoutMs: 0 } } };
    const demo = () => account.workers.get("every-app-gateway-demo")!.config["placement"];
    await runSetup(
      { json: true, "no-access": true, domain: "demo.example.com", name: "demo" },
      sink(),
      deps(nobody),
    ).catch(() => undefined);
    expect(demo()).toBeUndefined();

    // Nobody claimed demo: the update uploads, then stops at its owner link.
    await expect(update({ gateway: "demo", placement: "aws:ap-south-1" }, nobody)).rejects.toMatchObject({
      action: "claim_owner",
    });

    expect(demo()).toEqual({ region: "aws:ap-south-1" });
    expect(uploaded()).toEqual({ mode: "smart" });
    const demoD1 = cfD1Database(account.cf, [...account.databases].find(([, d]) => d.name === "every-app-gateway-demo")![0]);
    await expect(readInstall(demoD1)).resolves.toMatchObject({ placement: "aws:ap-south-1" });
    await expect(recorded()).resolves.toBe("smart");
  });
});

describe("setup --placement", () => {
  it("records nothing until an upload happens: a failed first install doesn't keep the value", async () => {
    account.failNextDeploy = "Cloudflare refused the upload";

    await expect(setup({ placement: "aws:ap-south1" })).rejects.toThrow();

    await expect(recorded()).resolves.toBeNull();
    await setup();
    expect(account.workers.get(WORKER)!.config).not.toHaveProperty("placement");
  });

  it("makes the first upload with it, and records it", async () => {
    await expect(setup({ placement: "smart" })).resolves.toMatchObject({ gateway: "installed" });

    expect(uploaded()).toEqual({ mode: "smart" });
    await expect(recorded()).resolves.toBe("smart");
  });

  it("changes a Gateway that is already live", async () => {
    await setup();
    const before = uploads();

    await setup({ placement: "aws:ap-south-1" });

    expect(uploads()).toBe(before + 1);
    expect(uploaded()).toEqual({ region: "aws:ap-south-1" });
  });

  it("refuses a value it doesn't know before asking Cloudflare anything", async () => {
    await expect(setup({ placement: "nowhere" })).rejects.toMatchObject({ code: "INVALID_PLACEMENT" });

    expect(account.cf.calls).toHaveLength(0);
  });
});

describe("with no placement chosen", () => {
  it("uploads exactly what it always has: no placement key at all", async () => {
    await setup();
    expect(account.workers.get(WORKER)!.config).not.toHaveProperty("placement");
    await expect(recorded()).resolves.toBeNull();

    await updateToNewer();

    expect(account.workers.get(WORKER)!.config).not.toHaveProperty("placement");
    await expect(recorded()).resolves.toBeNull();
  });

  it("reads an install row from before the column existed, and adds it when there is a choice", async () => {
    await setup();
    account.database(WORKER).sqlite.exec("ALTER TABLE _everyapp_install DROP COLUMN placement");
    await expect(recorded()).resolves.toBeNull();

    await update({ placement: "smart" });

    expect(uploaded()).toEqual({ mode: "smart" });
    await expect(recorded()).resolves.toBe("smart");
  });
});
