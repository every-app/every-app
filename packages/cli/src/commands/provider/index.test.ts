/**
 * `everyapp provider on|off|list` end to end, in a fake Cloudflare account
 * with a deployed gateway (as secret/index.test.ts): the row, the access,
 * the key's state as a warning and in the list, and the way back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { existingGateway } from "@/lib/gateway/connect";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { listSecrets } from "../secret";
import { reportStatus } from "../status";
import { listProviders, turnOff, turnOn } from "./index";

const GATEWAY = "every-app-gateway";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const gatewayWorker = () => account.workers.get(GATEWAY)!;
const done = () => events.find((event) => event["type"] === "done");
const warnings = (code: string) =>
  events.filter((event) => event["type"] === "warning" && event["code"] === code);
const createCf = vi.fn(() => account.cf);

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
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
  events = [];
});

const dirs: string[] = [];

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory with no app in it. */
function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-provider-none-"));
  dirs.push(dir);
  return dir;
}

const rows = async () =>
  (
    await db().run([
      { sql: "SELECT app_slug, tier, status, hostname, worker_name FROM apps ORDER BY app_slug" },
    ])
  )[0] ?? [];

describe("provider on", () => {
  it("writes the row, says who can use it and where its tools are, and warns about the unset key", async () => {
    await turnOn({ flags, out: out(), createCf }, "dataforseo");

    expect(events.find((event) => event["type"] === "error")).toBeUndefined();
    expect(await rows()).toEqual([
      { app_slug: "dataforseo", tier: "provider", status: "active", hostname: null, worker_name: null },
    ]);
    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("DATAFORSEO_API_KEY isn't set on the Gateway"),
        data: { fix: "pnpm everyapp secret set DATAFORSEO_API_KEY", name: "DATAFORSEO_API_KEY" },
      }),
    ]);
    expect(done()).toMatchObject({
      message: expect.stringContaining("DataForSEO is on for"),
      data: {
        id: "dataforseo",
        name: "DataForSEO",
        on: true,
        was: "new",
        key: { name: "DATAFORSEO_API_KEY", set: false },
        mcp: { url: "https://example.com/mcp", toolPrefix: "dataforseo_" },
        next: [{ command: "pnpm everyapp secret set DATAFORSEO_API_KEY", note: "the provider's key" }],
      },
    });
    expect(done()!["message"]).toContain("https://example.com/mcp as dataforseo_<tool>");
  });

  it("reports a set key, and a second run as already on", async () => {
    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    await turnOn({ flags, out: out(), createCf }, "dataforseo");
    await turnOn({ flags, out: out(), createCf }, "dataforseo");

    expect(warnings("PROVIDER_KEY_UNSET")).toEqual([]);
    const dones = events.filter((event) => event["type"] === "done");
    expect(dones[0]!["data"]).toMatchObject({ was: "new", key: { set: true } });
    expect(dones[1]!["data"]).toMatchObject({ was: "existing", key: { set: true } });
    expect(dones[1]?.["data"]?.["next"]).toBeUndefined();
    expect((await rows()).filter((row) => row["app_slug"] === "dataforseo")).toHaveLength(1);
  });

  it("refuses an unknown provider before writing anything", async () => {
    await expect(turnOn({ flags, out: out(), createCf }, "ahrefs")).rejects.toMatchObject({
      code: "PROVIDER_APP_UNKNOWN",
      message: '"ahrefs" is not a provider app. The Gateway offers: dataforseo.',
    });
    expect(await rows()).toEqual([]);
  });
});

describe("provider off", () => {
  it("tombstones the row, and says when it was off already", async () => {
    await turnOn({ flags, out: out(), createCf }, "dataforseo");
    events = [];
    await turnOff({ flags, out: out(), createCf }, "dataforseo");
    expect(done()).toMatchObject({
      message: expect.stringContaining("DataForSEO is off for"),
      data: { id: "dataforseo", on: false, wasOn: true, key: { name: "DATAFORSEO_API_KEY", set: false } },
    });
    expect(await rows()).toEqual([
      expect.objectContaining({ app_slug: "dataforseo", tier: "provider", status: "deleted" }),
    ]);

    events = [];
    await turnOff({ flags, out: out(), createCf }, "dataforseo");
    expect(done()).toMatchObject({
      message: expect.stringContaining("was off already"),
      data: { wasOn: false },
    });
  });
});

describe("provider list", () => {
  it("lists each provider app with its state and key, and what to run next", async () => {
    await listProviders({ flags, out: out(), createCf });
    expect(done()).toMatchObject({
      message: "0 of 1 provider app on",
      data: {
        providers: [
          { id: "dataforseo", name: "DataForSEO", on: false, key: { name: "DATAFORSEO_API_KEY", set: false } },
        ],
        mcp: "https://example.com/mcp",
        next: [
          { command: "pnpm everyapp provider on dataforseo", note: "offer DataForSEO" },
          { command: "pnpm everyapp secret set DATAFORSEO_API_KEY", note: "DataForSEO's key" },
        ],
      },
    });

    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    await turnOn({ flags, out: out(), createCf }, "dataforseo");
    events = [];
    await listProviders({ flags, out: out(), createCf });
    expect(done()).toMatchObject({
      message: "1 of 1 provider app on",
      data: { providers: [{ id: "dataforseo", on: true, key: { set: true } }] },
    });
    expect(done()!["data"]["next"]).toBeUndefined();
  });
});

describe("a provider row and the other commands", () => {
  it("is left out of status and secret list, which have no Worker to read for it", async () => {
    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    await turnOn({ flags, out: out(), createCf }, "dataforseo");
    events = [];

    await reportStatus({
      gateway: await existingGateway({ json: true, out: out(), createCf }),
      out: out(),
      checkout: null,
    });
    const status = done()!;
    expect(status["data"]["apps"]).toEqual([]);
    expect((status["data"]["fixes"] as Array<{ code: string }>).map((fix) => fix.code)).not.toContain(
      "SETTINGS_UNKNOWN",
    );

    events = [];
    await listSecrets({ flags, out: out(), cwd: emptyDir(), createCf });
    expect(done()).toMatchObject({ data: { apps: [], gateway: { names: expect.arrayContaining(["DATAFORSEO_API_KEY"]) } } });
    expect(done()!["message"]).not.toContain("couldn't");
  });
});
