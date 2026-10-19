/**
 * `everyapp secret set|unset|list` end to end, in a fake Cloudflare
 * account with a deployed gateway and apps (as deployApp.test.ts): each
 * name goes where it belongs with no flag, refusals come before a value is
 * read or a Worker changes, and `list` says what each side holds and lacks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readInstall } from "@/lib/gateway/install";
import { readApp } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "../deploy/deployApp";
import { listSecrets, setSecrets, unsetSecrets } from "./index";

const GATEWAY = "every-app-gateway";

/** An app with two secrets of its own, an AI provider and a capability. */
const TODO: EveryAppCliManifest = {
  id: "todo",
  resources: { d1: ["DB"], kv: ["KV"] },
  secrets: ["GITHUB_TOKEN", "STRIPE_KEY"],
  providers: ["openai"],
  capabilities: { dataforseo: { access: "read" }, email: { access: "write" } },
};

/** An app with a helper Worker, which shares its secrets. */
const SEO: EveryAppCliManifest = {
  id: "seo",
  resources: { d1: ["DB"] },
  workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
  secrets: ["GITHUB_TOKEN"],
};

const VALUES: Record<string, string> = {
  GITHUB_TOKEN: "ghp_token",
  STRIPE_KEY: "sk_live",
  OPENAI_API_KEY: "sk-openai",
  EMAIL_FROM: "hello@example.com",
};

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
const dirs: string[] = [];

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
const warnings = () => events.filter((event) => event["type"] === "warning");

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
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory with no app in it. */
function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-secret-none-"));
  dirs.push(dir);
  return dir;
}

/** An app's directory: its real everyapp.config.ts, and what the fake build needs. */
function appDir(manifest: EveryAppCliManifest): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-secret-app-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "everyapp.config.ts"),
    `export default ${JSON.stringify(manifest, null, 2)} as const;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(dir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "drizzle", "0000_init.sql"),
    "CREATE TABLE todos (id text PRIMARY KEY, title text);",
  );
  fs.writeFileSync(
    path.join(dir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
  account.apps.set(dir, manifest);
  return dir;
}

async function deploy(dir: string, manifest: EveryAppCliManifest): Promise<string> {
  await deployApp({
    cwd: dir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: {
      ...seams,
      openRelease: () => openRelease(tarball),
      source: () => releaseSource(tarball),
    },
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
  events = [];
  return (await readApp(db(), manifest.id)).workerName;
}

const read = vi.fn(async (name: string) => VALUES[name]!);
const createCf = vi.fn(() => account.cf);

function set(cwd: string, ...names: string[]) {
  return setSecrets({ flags, out: out(), cwd, createCf, names, readValue: read });
}
function unset(cwd: string, ...names: string[]) {
  return unsetSecrets({ flags, out: out(), cwd, createCf, names });
}
function list(cwd: string) {
  return listSecrets({ flags, out: out(), cwd, createCf });
}

describe("secret set routes each name by what it is", () => {
  it("sets a Gateway setting on the Gateway from anywhere, recording the version", async () => {
    const before = gatewayWorker().versions.length;
    await set(emptyDir(), "OPENAI_API_KEY");

    expect(gatewayWorker().secrets["OPENAI_API_KEY"]).toBe("sk-openai");
    expect(gatewayWorker().versions).toHaveLength(before + 1);
    expect((await readInstall(db()))!.liveVersionId).toBe(gatewayWorker().versions.at(-1));
    expect(done()).toMatchObject({
      message: `Set OPENAI_API_KEY on ${GATEWAY}.`,
      data: { gateway: { names: ["OPENAI_API_KEY"] } },
    });
    expect(done()!["data"]["app"]).toBeUndefined();
  });

  it("sets a Gateway setting from an app's directory, deployed or not, without reading its manifest", async () => {
    const dir = appDir(TODO);
    fs.writeFileSync(path.join(dir, "everyapp.config.ts"), "export default { id: 1 };\n");
    await set(dir, "EMAIL_FROM");
    expect(gatewayWorker().secrets["EMAIL_FROM"]).toBe("hello@example.com");
  });

  it("sets a secret the manifest lists on the app's Worker and each helper", async () => {
    const dir = appDir(SEO);
    const workerName = await deploy(dir, SEO);
    const helper = `${workerName}--audit`;
    const gatewayVersions = gatewayWorker().versions.length;

    await set(dir, "GITHUB_TOKEN");

    expect(account.workers.get(workerName)!.secrets["GITHUB_TOKEN"]).toBe("ghp_token");
    expect(account.workers.get(helper)!.secrets["GITHUB_TOKEN"]).toBe("ghp_token");
    expect(gatewayWorker().versions).toHaveLength(gatewayVersions);
    expect(done()).toMatchObject({
      message: `Set GITHUB_TOKEN on ${workerName} and its helper.`,
      data: {
        app: {
          id: "seo",
          workerName,
          names: ["GITHUB_TOKEN"],
          versions: {
            [workerName]: account.workers.get(workerName)!.versions.at(-1),
            [helper]: account.workers.get(helper)!.versions.at(-1),
          },
        },
      },
    });
  });

  it("takes Gateway and app names in one call, the Gateway's first", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);

    await set(dir, "GITHUB_TOKEN", "OPENAI_API_KEY", "STRIPE_KEY");

    expect(gatewayWorker().secrets["OPENAI_API_KEY"]).toBe("sk-openai");
    expect(account.workers.get(workerName)!.secrets).toMatchObject({
      GITHUB_TOKEN: "ghp_token",
      STRIPE_KEY: "sk_live",
    });
    expect(gatewayWorker().secrets["GITHUB_TOKEN"]).toBeUndefined();
    expect(account.workers.get(workerName)!.secrets["OPENAI_API_KEY"]).toBeUndefined();
    expect(done()).toMatchObject({
      message: `Set OPENAI_API_KEY on ${GATEWAY}, and GITHUB_TOKEN, STRIPE_KEY on ${workerName}.`,
      data: {
        gateway: { names: ["OPENAI_API_KEY"] },
        app: { names: ["GITHUB_TOKEN", "STRIPE_KEY"] },
      },
    });
    // The routing is on record before anything changed.
    expect(
      events
        .filter((event) => event["step"] === "secrets.route")
        .map((event) => event["message"]),
    ).toEqual([
      `OPENAI_API_KEY: ${GATEWAY}`,
      `GITHUB_TOKEN: ${workerName}`,
      `STRIPE_KEY: ${workerName}`,
    ]);
  });
});

describe("secret set refuses a name that goes nowhere, before a value is read", () => {
  beforeEach(() => {
    read.mockClear();
    createCf.mockClear();
  });

  it("refuses a name the app's manifest doesn't list, pointing at everyapp.config.ts and the app's Gateway settings", async () => {
    const dir = appDir(TODO);
    await expect(set(dir, "SENDGRID_KEY")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message:
        "SENDGRID_KEY isn't a Gateway setting, and todo doesn't list it under secrets in everyapp.config.ts; add it there to set it on the app. Gateway settings todo uses: OPENAI_API_KEY, DATAFORSEO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME, EMAIL_REST_API_TOKEN, RESEND_API_KEY, EMAIL_PROVIDER.",
    });
    expect(read).not.toHaveBeenCalled();
    expect(createCf).not.toHaveBeenCalled();
  });

  it("suggests the name that differs in case or underscores only", async () => {
    await expect(set(appDir(TODO), "openai_api_key")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message: expect.stringContaining("Did you mean OPENAI_API_KEY?"),
    });
    await expect(set(appDir(TODO), "GITHUBTOKEN")).rejects.toMatchObject({
      message: expect.stringContaining("Did you mean GITHUB_TOKEN?"),
    });
  });

  it("outside an app directory, says where an app's secret is set", async () => {
    await expect(set(emptyDir(), "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message:
        "GITHUB_TOKEN isn't a Gateway setting. To set an app's own secret, run this in the app's directory, where everyapp.config.ts lists it under secrets. `everyapp secret list --json` includes every Gateway setting this command sets (gateway.settable).",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the Gateway's own settings for the install, and lets an app list one as its own", async () => {
    await expect(set(emptyDir(), "BETTER_AUTH_SECRET")).rejects.toMatchObject({
      code: "SECRET_NOT_SETTABLE",
      message:
        "BETTER_AUTH_SECRET is one of the Gateway's own settings, written once by `everyapp setup`; this command never changes it.",
    });
    await expect(set(emptyDir(), "THIRD_PARTY_DEPLOYS")).rejects.toMatchObject({
      code: "SECRET_NOT_SETTABLE",
      message: expect.stringContaining("opened by hand"),
    });
    await expect(set(appDir(TODO), "BETTER_AUTH_SECRET")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message: expect.stringContaining(
        "It is also one of the Gateway's own settings, which `everyapp setup` writes; listing it under secrets gives todo a secret of its own.",
      ),
    });
    const own: EveryAppCliManifest = { ...SEO, id: "seo2", secrets: ["BETTER_AUTH_SECRET"] };
    const dir = appDir(own);
    const workerName = await deploy(dir, own);
    VALUES["BETTER_AUTH_SECRET"] = "own-secret";
    await set(dir, "BETTER_AUTH_SECRET");
    expect(account.workers.get(workerName)!.secrets["BETTER_AUTH_SECRET"]).toBe("own-secret");
    expect(gatewayWorker().secrets["BETTER_AUTH_SECRET"]).not.toBe("own-secret");
  });

  it("refuses reserved and malformed names with their own codes", async () => {
    await expect(set(appDir(TODO), "EVERY_APP_ORG_ID")).rejects.toMatchObject({
      code: "SECRET_NAME_RESERVED",
    });
    await expect(set(appDir(TODO), "not-a-name")).rejects.toMatchObject({
      code: "SECRET_NAME_INVALID",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a manifest that is there but invalid, when an app name needs it", async () => {
    const dir = appDir(TODO);
    fs.writeFileSync(
      path.join(dir, "everyapp.config.ts"),
      'export default { id: "todo", secrets: ["OPENAI_API_KEY"] };\n',
    );
    await expect(set(dir, "GITHUB_TOKEN")).rejects.toThrow(
      /secrets\.0: OPENAI_API_KEY is a Gateway setting/,
    );
  });
});

describe("secret set changes nothing until every target checks out", () => {
  it("leaves the Gateway alone when the app in a mixed call isn't deployed yet", async () => {
    const dir = appDir(TODO);
    const before = gatewayWorker().versions.length;
    await expect(set(dir, "OPENAI_API_KEY", "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
    });
    expect(gatewayWorker().versions).toHaveLength(before);
  });

  it("leaves the Gateway alone when the app's Worker serves a version everyapp didn't record", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    account.workers.get(workerName)!.versions.push("dashboard-edit");
    const before = gatewayWorker().versions.length;

    await expect(set(dir, "OPENAI_API_KEY", "GITHUB_TOKEN")).rejects.toMatchObject({
      action: "rerun_interactive",
    });
    expect(gatewayWorker().versions).toHaveLength(before);
    expect(account.workers.get(workerName)!.secrets["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("refuses a --gateway URL that isn't this Gateway's", async () => {
    const before = gatewayWorker().versions.length;
    await expect(
      setSecrets({
        flags: { json: true, gateway: "https://other.example" },
        out: out(),
        cwd: emptyDir(),
        createCf,
        names: ["OPENAI_API_KEY"],
        readValue: read,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_URL_MISMATCH" });
    expect(gatewayWorker().versions).toHaveLength(before);
  });
});

describe("secret unset", () => {
  it("removes a Gateway setting from the Gateway and an app's secret from the app, each where it is", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    await set(dir, "OPENAI_API_KEY", "GITHUB_TOKEN");
    events = [];

    await unset(dir, "OPENAI_API_KEY", "GITHUB_TOKEN");

    expect(gatewayWorker().secrets["OPENAI_API_KEY"]).toBeUndefined();
    expect(account.workers.get(workerName)!.secrets["GITHUB_TOKEN"]).toBeUndefined();
    expect(done()).toMatchObject({
      message: `Removed OPENAI_API_KEY from ${GATEWAY}, and GITHUB_TOKEN from ${workerName}.`,
    });
  });

  it("removes a secret the manifest no longer lists, and says so", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    await set(dir, "STRIPE_KEY");
    // The manifest without it (another checkout of the app: one process
    // loads a manifest once).
    const dropped = appDir({ ...TODO, secrets: ["GITHUB_TOKEN"] });
    events = [];

    await unset(dropped, "STRIPE_KEY");

    expect(account.workers.get(workerName)!.secrets["STRIPE_KEY"]).toBeUndefined();
    expect(warnings()).toEqual([
      expect.objectContaining({
        code: "SECRET_NOT_DECLARED",
        message:
          "STRIPE_KEY isn't listed under secrets in everyapp.config.ts; removing it from todo's Workers anyway.",
      }),
    ]);
    expect(done()).toMatchObject({ message: `Removed STRIPE_KEY from ${workerName}.` });
  });

  it("makes no version for a name nobody holds, and refuses when none does", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    const versions = account.workers.get(workerName)!.versions.length;

    await expect(unset(dir, "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "SECRET_NOT_SET",
      message: `Nothing to remove: ${workerName} doesn't have the named secrets.`,
    });
    expect(account.workers.get(workerName)!.versions).toHaveLength(versions);
    expect(warnings()).toEqual([
      expect.objectContaining({
        code: "SECRET_NOT_SET",
        message: `GITHUB_TOKEN isn't set on ${workerName}.`,
      }),
    ]);

    // Held on one target only: removed there, said for the other.
    events = [];
    await set(dir, "GITHUB_TOKEN");
    events = [];
    await unset(dir, "GITHUB_TOKEN", "STRIPE_KEY");
    expect(warnings().map((event) => event["message"])).toEqual([
      `STRIPE_KEY isn't set on ${workerName}.`,
    ]);
    expect(done()).toMatchObject({ message: `Removed GITHUB_TOKEN from ${workerName}.` });
  });

  it("outside an app directory, takes Gateway settings only", async () => {
    await expect(unset(emptyDir(), "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
    });
  });
});

describe("secret list", () => {
  it("outside an app directory, names the Gateway's secrets and what this command can set", async () => {
    await set(emptyDir(), "OPENAI_API_KEY");
    events = [];
    await list(emptyDir());
    const names = gatewayWorker().versions.length > 0 ? Object.keys(gatewayWorker().secrets).sort() : [];
    expect(done()).toMatchObject({
      message: `${GATEWAY}: ${names.join(", ")}`,
      data: { gateway: { workerName: GATEWAY, names, settable: expect.arrayContaining(["OPENAI_API_KEY", "EMAIL_FROM"]) } },
    });
    expect(done()!["data"]["app"]).toBeUndefined();
  });

  it("in an app's directory, lists each Worker's names, what the manifest lists but nobody set, and the Gateway settings it uses", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    await set(dir, "GITHUB_TOKEN", "OPENAI_API_KEY");
    events = [];

    await list(dir);

    expect(done()!["message"]).toBe(
      [
        `${workerName}: EVERY_APP_ORG_ID, GATEWAY_URL, GITHUB_TOKEN`,
        `Listed under secrets in everyapp.config.ts, not set on ${workerName}: STRIPE_KEY`,
        "Gateway settings todo uses: OPENAI_API_KEY (set), DATAFORSEO_API_KEY (not set), EMAIL_FROM (not set), EMAIL_FROM_NAME (not set), EMAIL_REST_API_TOKEN (optional, not set), RESEND_API_KEY (optional, not set), EMAIL_PROVIDER (optional, not set)",
      ].join("\n"),
    );
    expect(done()!["data"]).toMatchObject({
      app: {
        id: "todo",
        deployed: true,
        workerName,
        declared: ["GITHUB_TOKEN", "STRIPE_KEY"],
        workers: [
          {
            workerName,
            names: ["EVERY_APP_ORG_ID", "GATEWAY_URL", "GITHUB_TOKEN"],
            missing: ["STRIPE_KEY"],
          },
        ],
      },
      gateway: {
        workerName: GATEWAY,
        needed: expect.arrayContaining([
          { name: "OPENAI_API_KEY", required: true, set: true },
          { name: "RESEND_API_KEY", required: false, set: false },
        ]),
        missing: ["DATAFORSEO_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME"],
      },
      next: ["pnpm everyapp secret set STRIPE_KEY DATAFORSEO_API_KEY EMAIL_FROM EMAIL_FROM_NAME"],
    });
  });

  it("shows a helper that lacks a secret the app's Worker has", async () => {
    const dir = appDir(SEO);
    const workerName = await deploy(dir, SEO);
    const helper = `${workerName}--audit`;
    await set(dir, "GITHUB_TOKEN");
    delete account.workers.get(helper)!.secrets["GITHUB_TOKEN"];
    events = [];

    await list(dir);

    expect(done()!["message"]).toBe(
      [
        `${workerName}: EVERY_APP_ORG_ID, GATEWAY_URL, GITHUB_TOKEN`,
        `${helper}: EVERY_APP_ORG_ID, GATEWAY_URL`,
        `Listed under secrets in everyapp.config.ts, not set on ${helper}: GITHUB_TOKEN`,
      ].join("\n"),
    );
    expect(done()!["data"]["next"]).toBeUndefined();
  });

  it("in an app's directory before its first deploy, says so and still reports the Gateway settings it uses", async () => {
    await list(appDir(TODO));
    expect(done()!["message"]).toBe(
      [
        "todo isn't deployed yet; its own secrets are set after its first `everyapp deploy`. It lists: GITHUB_TOKEN, STRIPE_KEY.",
        "Gateway settings todo uses: OPENAI_API_KEY (not set), DATAFORSEO_API_KEY (not set), EMAIL_FROM (not set), EMAIL_FROM_NAME (not set), EMAIL_REST_API_TOKEN (optional, not set), RESEND_API_KEY (optional, not set), EMAIL_PROVIDER (optional, not set)",
      ].join("\n"),
    );
    expect(done()!["data"]).toMatchObject({
      app: { id: "todo", deployed: false, workerName: null, workers: [] },
      next: ["pnpm everyapp secret set OPENAI_API_KEY DATAFORSEO_API_KEY EMAIL_FROM EMAIL_FROM_NAME"],
    });
  });
});
