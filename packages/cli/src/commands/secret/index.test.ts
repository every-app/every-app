/**
 * `everyapp secret set|unset|list` end to end, in a fake Cloudflare
 * account with a deployed gateway and apps (as deployApp.test.ts): each
 * name goes where it belongs with no flag (or to the app `--app` names,
 * from anywhere, by the manifest its deploy stored), refusals come before
 * a value is read or a Worker changes, each change records the app
 * Worker's secret names on its row, and `list` says what each app needs
 * and what is set, in the settings model's words.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHostedOnlyGatewaySetting, SETTABLE_GATEWAY_SETTINGS } from "@every-app/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readInstall, writeInstall } from "@/lib/gateway/install";
import { readApp, register } from "@/lib/gateway/registry";
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

/** An app with no secrets of its own and nothing that needs a Gateway setting. */
const NOTES: EveryAppCliManifest = { id: "notes", resources: { d1: ["DB"] } };

/**
 * An app that says what each setting is for and which it can do without
 * (object entries), and picks its AI provider among the set ones.
 */
const CRM: EveryAppCliManifest = {
  id: "crm",
  resources: { d1: ["DB"] },
  providers: [
    { id: "openai", anyOf: "AI model" },
    { id: "openrouter", anyOf: "AI model", why: "Any model through one key." },
  ],
  capabilities: {
    context: { access: "read", optional: true, why: "Renders JavaScript pages in audits." },
  },
  secrets: [
    { name: "TOKEN_ENCRYPTION_KEY", why: "Encrypts the OAuth tokens it stores." },
    { name: "GITHUB_TOKEN", optional: true, why: "Raises the GitHub rate limit." },
  ],
};

const VALUES: Record<string, string> = {
  GITHUB_TOKEN: "ghp_token",
  STRIPE_KEY: "sk_live",
  OPENAI_API_KEY: "sk-openai",
  OPENROUTER_API_KEY: "sk-or",
  EMAIL_FROM: "hello@example.com",
  TOKEN_ENCRYPTION_KEY: "tek",
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
  return unsetSecrets({ flags: { ...flags, yes: true }, out: out(), cwd, createCf, names });
}
function list(cwd: string, appId?: string) {
  return listSecrets({ flags, out: out(), cwd, createCf, appId });
}
/** `--app <id>`: the app named, from wherever the command runs. */
function setFor(appId: string, cwd: string, ...names: string[]) {
  return setSecrets({ flags: { ...flags, app: appId }, out: out(), cwd, createCf, names, readValue: read });
}
function unsetFor(appId: string, cwd: string, ...names: string[]) {
  return unsetSecrets({ flags: { ...flags, yes: true, app: appId }, out: out(), cwd, createCf, names });
}
/** The app's secret names as its row records them (`secret_names`), or null when never recorded. */
const recorded = async (appId: string) => (await readApp(db(), appId)).secretNames;
const progress = (step: string) =>
  events.filter((event) => event["type"] === "progress" && event["step"] === step).map((event) => event["message"]);

describe("secret set routes each name by what it is", () => {
  it("sets a Gateway setting on the Gateway from anywhere, recording the version, a step for it", async () => {
    const before = gatewayWorker().versions.length;
    await set(emptyDir(), "OPENAI_API_KEY");

    expect(gatewayWorker().secrets["OPENAI_API_KEY"]).toBe("sk-openai");
    expect(gatewayWorker().versions).toHaveLength(before + 1);
    expect((await readInstall(db()))!.liveVersionId).toBe(gatewayWorker().versions.at(-1));
    expect(events.filter((event) => event["step"] === "secrets.gateway")).toEqual([
      expect.objectContaining({ status: "start", message: "Updating the Gateway..." }),
      expect.objectContaining({
        status: "ok",
        message: "Set OPENAI_API_KEY on the Gateway",
        data: { action: "set", names: ["OPENAI_API_KEY"], versions: { [GATEWAY]: gatewayWorker().versions.at(-1) } },
      }),
    ]);
    expect(done()).toMatchObject({
      message: "Set OPENAI_API_KEY on the Gateway",
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

  it("sets a secret the manifest lists on the app's Worker and each helper, as one step", async () => {
    const dir = appDir(SEO);
    const workerName = await deploy(dir, SEO);
    const helper = `${workerName}--audit`;
    const gatewayVersions = gatewayWorker().versions.length;

    await set(dir, "GITHUB_TOKEN");

    expect(account.workers.get(workerName)!.secrets["GITHUB_TOKEN"]).toBe("ghp_token");
    expect(account.workers.get(helper)!.secrets["GITHUB_TOKEN"]).toBe("ghp_token");
    expect(gatewayWorker().versions).toHaveLength(gatewayVersions);
    expect(done()).toMatchObject({
      message: "Set GITHUB_TOKEN on seo",
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
    expect(progress("secrets.version")).toEqual([
      `${workerName} is now at version ${account.workers.get(workerName)!.versions.at(-1)}`,
      `${helper} is now at version ${account.workers.get(helper)!.versions.at(-1)}`,
    ]);
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
      message: "Set OPENAI_API_KEY on the Gateway, and GITHUB_TOKEN and STRIPE_KEY on todo",
      data: {
        gateway: { names: ["OPENAI_API_KEY"] },
        app: { names: ["GITHUB_TOKEN", "STRIPE_KEY"] },
      },
    });
    // The routing is on record (--verbose) before anything changed.
    expect(progress("secrets.route")).toEqual([
      `OPENAI_API_KEY is a Gateway setting → Worker ${GATEWAY}`,
      `GITHUB_TOKEN is todo's secret → Worker ${workerName}`,
      `STRIPE_KEY is todo's secret → Worker ${workerName}`,
    ]);
  });

  it("names only what is left when a later Worker fails, so no value is asked twice", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    account.cf.override(
      (args) => args.slice(0, 3).join(" ") === "workers secrets bulk" && args.includes(workerName),
      { exitCode: 1, stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n" },
    );

    await expect(set(dir, "OPENAI_API_KEY", "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "SECRETS_PARTIALLY_APPLIED",
      message: expect.stringMatching(
        /^Couldn't set GITHUB_TOKEN on todo\nCloudflare said: .*Authentication error.*\nOPENAI_API_KEY is set; only GITHUB_TOKEN is left\.$/,
      ),
      rerun: "pnpm everyapp secret set GITHUB_TOKEN",
      data: { left: ["GITHUB_TOKEN"], applied: { gateway: { names: ["OPENAI_API_KEY"] } } },
    });
    expect(gatewayWorker().secrets["OPENAI_API_KEY"]).toBe("sk-openai");
  });
});

describe("secret set refuses a name that goes nowhere, before a value is read", () => {
  beforeEach(() => {
    read.mockClear();
    createCf.mockClear();
  });

  it("refuses a name the app's manifest doesn't list, showing the line to add", async () => {
    const dir = appDir(TODO);
    await expect(set(dir, "SENDGRID_KEY")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message: "todo doesn't list SENDGRID_KEY as a secret\nIt isn't a Gateway setting either.",
      fix: 'add it to secrets in everyapp.config.ts: secrets: ["GITHUB_TOKEN", "STRIPE_KEY", "SENDGRID_KEY"],',
      rerun: "pnpm everyapp secret set SENDGRID_KEY",
    });
    expect(read).not.toHaveBeenCalled();
    expect(createCf).not.toHaveBeenCalled();
  });

  it("suggests the name that differs in case or underscores only, and the command with it", async () => {
    await expect(set(emptyDir(), "openai_api_key")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message: "openai_api_key isn't a Gateway setting",
      rerun: "pnpm everyapp secret set OPENAI_API_KEY",
      data: { didYouMean: "OPENAI_API_KEY" },
    });
    await expect(set(appDir(TODO), "GITHUBTOKEN")).rejects.toMatchObject({
      message: "GITHUBTOKEN isn't a Gateway setting or one of todo's secrets",
      data: { didYouMean: "GITHUB_TOKEN" },
    });
  });

  it("outside an app directory, says where an app's secret is set", async () => {
    await expect(set(emptyDir(), "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message:
        "GITHUB_TOKEN isn't a Gateway setting, and there's no app here\nAn app's own secrets are set from the app's directory (where everyapp.config.ts is), or from anywhere with --app <id>.\nGateway settings: pnpm everyapp secret list",
      fix: "cd into the app's directory and run this again, or add --app <id>",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("renders the line to add in the manifest's own form when its entries are objects", async () => {
    const dir = appDir(CRM);
    await expect(set(dir, "SENDGRID_KEY")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      fix: 'add it to secrets in everyapp.config.ts: secrets: [{ name: "TOKEN_ENCRYPTION_KEY", why: "Encrypts the OAuth tokens it stores." }, { name: "GITHUB_TOKEN", why: "Raises the GitHub rate limit.", optional: true }, { name: "SENDGRID_KEY" }],',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the Gateway's own settings for the install, and lets an app list one as its own", async () => {
    await expect(set(emptyDir(), "BETTER_AUTH_SECRET")).rejects.toMatchObject({
      code: "SECRET_NOT_SETTABLE",
      message: "BETTER_AUTH_SECRET can't be changed with secret set\nIt's one of the Gateway's own keys, written once by setup.",
    });
    await expect(set(emptyDir(), "THIRD_PARTY_DEPLOYS")).rejects.toMatchObject({
      code: "SECRET_NOT_SETTABLE",
      message: expect.stringContaining("opened by hand"),
    });
    await expect(set(emptyDir(), "MCP_ACCESS_TOKEN_TTL")).rejects.toMatchObject({
      code: "SECRET_NOT_SETTABLE",
      message: "MCP_ACCESS_TOKEN_TTL only works in local development\nA deployed Gateway doesn't read it.",
      fix: "set it in the Gateway's .dev.vars",
    });
    await expect(set(appDir(TODO), "BETTER_AUTH_SECRET")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message: expect.stringContaining(
        "It's one of the Gateway's own keys; listing it under secrets gives todo a secret of its own.",
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
      message: expect.stringMatching(/^EVERY_APP_ORG_ID is a reserved name\neveryapp manages /),
    });
    await expect(set(appDir(TODO), "not-a-name")).rejects.toMatchObject({
      code: "SECRET_NAME_INVALID",
      message: '"not-a-name" isn\'t a valid secret name',
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
  it("asks for no value, and leaves the Gateway alone, when the app in a mixed call isn't deployed yet", async () => {
    read.mockClear();
    const dir = appDir(TODO);
    const before = gatewayWorker().versions.length;
    await expect(set(dir, "OPENAI_API_KEY", "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: "todo isn't deployed yet\nIts secrets can be set after its first deploy. Nothing was changed.",
      rerun: "pnpm everyapp deploy",
    });
    expect(read).not.toHaveBeenCalled();
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
      message: "Removed OPENAI_API_KEY from the Gateway, and GITHUB_TOKEN from todo",
    });
  });

  it("asks first, saying a name the manifest no longer lists, and needs --yes without a terminal", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    await set(dir, "STRIPE_KEY");
    // The manifest without it (another checkout of the app: one process
    // loads a manifest once).
    const dropped = appDir({ ...TODO, secrets: ["GITHUB_TOKEN"] });
    events = [];

    await expect(
      unsetSecrets({ flags, out: out(), cwd: dropped, createCf, names: ["STRIPE_KEY"] }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED", authorize: true });
    expect(account.workers.get(workerName)!.secrets["STRIPE_KEY"]).toBe("sk_live");

    const confirm = vi.fn(async () => false);
    await expect(
      unsetSecrets({ flags, out: out(), cwd: dropped, createCf, names: ["STRIPE_KEY"], interactive: true, confirm }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(confirm).toHaveBeenCalledWith("Remove STRIPE_KEY from todo?", [
      "STRIPE_KEY isn't listed in everyapp.config.ts.",
    ]);
    expect(account.workers.get(workerName)!.secrets["STRIPE_KEY"]).toBe("sk_live");

    events = [];
    await unset(dropped, "STRIPE_KEY");
    expect(account.workers.get(workerName)!.secrets["STRIPE_KEY"]).toBeUndefined();
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
    expect(done()).toMatchObject({ message: "Removed STRIPE_KEY from todo" });
  });

  it("changes nothing, and succeeds, for a name nobody holds", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    const versions = account.workers.get(workerName)!.versions.length;

    const sink = out();
    await unsetSecrets({ flags, out: sink, cwd: dir, createCf, names: ["GITHUB_TOKEN"] });
    expect(sink.exitCode).toBe(0);
    expect(done()).toMatchObject({ message: "GITHUB_TOKEN isn't set on todo. Nothing changed." });
    expect(account.workers.get(workerName)!.versions).toHaveLength(versions);

    // Held on one target only: removed there, said (--verbose) for the other.
    events = [];
    await set(dir, "GITHUB_TOKEN");
    events = [];
    await unset(dir, "GITHUB_TOKEN", "STRIPE_KEY");
    expect(progress("secrets.held")).toEqual([`STRIPE_KEY isn't set on ${workerName}`]);
    expect(done()).toMatchObject({ message: "Removed GITHUB_TOKEN from todo" });
  });

  it("outside an app directory, takes Gateway settings only", async () => {
    await expect(unset(emptyDir(), "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message: expect.stringContaining("An app's own secrets are removed from the app's directory"),
    });
  });
});

describe("secret set --app", () => {
  it("sets and removes an app's secret from anywhere, by the manifest its deploy stored, recording the names", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);
    expect(await recorded("crm")).toEqual([]);
    const elsewhere = emptyDir();

    await setFor("crm", elsewhere, "TOKEN_ENCRYPTION_KEY", "OPENROUTER_API_KEY");

    expect(account.workers.get(workerName)!.secrets["TOKEN_ENCRYPTION_KEY"]).toBe("tek");
    expect(gatewayWorker().secrets["OPENROUTER_API_KEY"]).toBe("sk-or");
    expect(done()).toMatchObject({
      message: "Set OPENROUTER_API_KEY on the Gateway, and TOKEN_ENCRYPTION_KEY on crm",
      data: { app: { id: "crm", workerName, names: ["TOKEN_ENCRYPTION_KEY"] } },
    });
    expect(await recorded("crm")).toEqual(["TOKEN_ENCRYPTION_KEY"]);

    events = [];
    await setFor("crm", elsewhere, "GITHUB_TOKEN");
    expect(await recorded("crm")).toEqual(["GITHUB_TOKEN", "TOKEN_ENCRYPTION_KEY"]);

    events = [];
    await unsetFor("crm", elsewhere, "GITHUB_TOKEN");
    expect(done()).toMatchObject({ message: "Removed GITHUB_TOKEN from crm" });
    expect(account.workers.get(workerName)!.secrets["GITHUB_TOKEN"]).toBeUndefined();
    expect(await recorded("crm")).toEqual(["TOKEN_ENCRYPTION_KEY"]);
  });

  it("wins over the app in the directory, and never reads its manifest", async () => {
    const todoDir = appDir(TODO);
    const todoWorker = await deploy(todoDir, TODO);
    const crmWorker = await deploy(appDir(CRM), CRM);
    fs.writeFileSync(path.join(todoDir, "everyapp.config.ts"), "export default { id: 1 };\n");

    await setFor("crm", todoDir, "TOKEN_ENCRYPTION_KEY");

    expect(account.workers.get(crmWorker)!.secrets["TOKEN_ENCRYPTION_KEY"]).toBe("tek");
    expect(account.workers.get(todoWorker)!.secrets["TOKEN_ENCRYPTION_KEY"]).toBeUndefined();
  });

  it("refuses a name the stored manifest doesn't list, saying so, and an app that isn't deployed, before a value is read", async () => {
    read.mockClear();
    await deploy(appDir(CRM), CRM);
    const elsewhere = emptyDir();

    await expect(setFor("crm", elsewhere, "SENDGRID_KEY")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message:
        "crm doesn't list SENDGRID_KEY as a secret\nIts deployed manifest (what --app crm reads) doesn't list it, and it isn't a Gateway setting either.",
      fix: expect.stringMatching(/^add it to secrets in everyapp\.config\.ts: secrets: \[.*\{ name: "SENDGRID_KEY" \}\], and deploy crm again$/),
      rerun: "pnpm everyapp secret set SENDGRID_KEY --app crm",
    });
    await expect(setFor("crm", elsewhere, "github_token")).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      rerun: "pnpm everyapp secret set GITHUB_TOKEN --app crm",
      data: { didYouMean: "GITHUB_TOKEN" },
    });
    await expect(setFor("nope", elsewhere, "GITHUB_TOKEN")).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: expect.stringContaining("nope isn't deployed to this Gateway"),
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("records the names after a change in the app's directory too", async () => {
    const dir = appDir(TODO);
    await deploy(dir, TODO);
    await set(dir, "GITHUB_TOKEN", "STRIPE_KEY", "OPENAI_API_KEY");
    expect(await recorded("todo")).toEqual(["GITHUB_TOKEN", "STRIPE_KEY"]);
    await unset(dir, "STRIPE_KEY");
    expect(await recorded("todo")).toEqual(["GITHUB_TOKEN"]);
  });
});

describe("secret list", () => {
  it("outside an app directory, names the Gateway's secrets, who set them, what else can be set, and every app's settings", async () => {
    await set(emptyDir(), "OPENAI_API_KEY");
    const todoDir = appDir(TODO);
    await deploy(todoDir, TODO);
    await set(todoDir, "GITHUB_TOKEN");
    await deploy(appDir(CRM), CRM);
    // An app with nothing to set has no rows.
    await deploy(appDir({ id: "plain", resources: { d1: ["DB"] } }), { id: "plain", resources: { d1: ["DB"] } });
    events = [];

    await list(emptyDir());

    const names = Object.keys(gatewayWorker().secrets).sort();
    const lines = (done()!["message"] as string).split("\n");
    expect(lines.slice(0, 3)).toEqual(["Gateway secrets · example.com", "", expect.stringMatching(/^NAME +SET BY$/)]);
    expect(lines).toContainEqual(expect.stringMatching(/^OPENAI_API_KEY +you$/));
    expect(lines).toContainEqual(expect.stringMatching(/^BETTER_AUTH_SECRET +setup$/));
    // Yours, then setup's, then, of what you could set, only what some app
    // reads (crm's other provider, todo's capabilities and what email also
    // reads), in the Gateway's order.
    const at = (name: string) => lines.findIndex((line) => line.startsWith(`${name} `));
    expect(at("OPENAI_API_KEY")).toBeLessThan(at("BETTER_AUTH_SECRET"));
    expect(at("BETTER_AUTH_SECRET")).toBeLessThan(at("OPENROUTER_API_KEY"));
    const unset = lines.filter((line) => / {2}not set$/.test(line)).map((line) => line.split(" ")[0]);
    expect(unset).toEqual([
      "OPENROUTER_API_KEY",
      "DATAFORSEO_API_KEY",
      "CONTEXT_API_KEY",
      "EMAIL_REST_API_TOKEN",
      "RESEND_API_KEY",
      "EMAIL_PROVIDER",
      "EMAIL_FROM",
      "EMAIL_FROM_NAME",
    ]);
    // The rest (the OAuth clients nobody uses, the Gateway's own switches)
    // are one line; the hosted Gateway's own don't count on this install.
    const relevant = SETTABLE_GATEWAY_SETTINGS.filter(
      (name) => !isHostedOnlyGatewaySetting(name) && name !== "OPENAI_API_KEY",
    );
    expect(lines).toContain(`${relevant.length - unset.length} more can be set; see docs/capabilities.md`);
    expect(lines).not.toContainEqual(expect.stringMatching(/^(LINKEDIN_CLIENT_ID|HOSTED_OPEN_SIGNUP|THIRD_PARTY_DOMAIN) /));
    // Then each app's settings, in manifest order, the Gateway's first.
    const table = lines.indexOf(lines.find((line) => /^APP +SETTING +WHERE +STATUS$/.test(line))!);
    expect(lines.slice(table)).toEqual([
      // The sender's two names are one setting: one row, joined with +.
      "APP   SETTING                     WHERE    STATUS",
      "crm   OPENAI_API_KEY              Gateway  ✓ set",
      "crm   OPENROUTER_API_KEY          Gateway  not set (one of: AI model)",
      "crm   CONTEXT_API_KEY             Gateway  not set (optional)",
      "crm   TOKEN_ENCRYPTION_KEY        crm      ! not set",
      "crm   GITHUB_TOKEN                crm      not set (optional)",
      "todo  OPENAI_API_KEY              Gateway  ✓ set",
      "todo  DATAFORSEO_API_KEY          Gateway  ! not set",
      "todo  EMAIL_FROM+EMAIL_FROM_NAME  Gateway  ! not set",
      "todo  GITHUB_TOKEN                todo     ✓ set",
      "todo  STRIPE_KEY                  todo     ! not set",
    ]);
    // The JSON keeps every settable name.
    expect(done()!["data"]).toMatchObject({
      gateway: { workerName: GATEWAY, names, settable: [...SETTABLE_GATEWAY_SETTINGS] },
      apps: [
        {
          id: "crm",
          setup: {
            ready: false,
            groups: [{ group: "AI model", met: true, members: ["openai", "openrouter"] }],
            command: { command: "pnpm everyapp configure crm" },
          },
        },
        {
          id: "todo",
          setup: {
            ready: false,
            command: { command: "pnpm everyapp configure todo" },
          },
        },
      ],
    });
    expect(done()!["data"]["app"]).toBeUndefined();
  });

  it("outside an app directory, keeps going when one app's Worker is gone, and leaves a dispatch-tier app out", async () => {
    const todoDir = appDir(TODO);
    const todoWorker = await deploy(todoDir, TODO);
    await set(todoDir, "GITHUB_TOKEN");
    const crmWorker = await deploy(appDir(CRM), CRM);
    // A third-party app on the hosted Gateway's dispatch tier: the platform doesn't gate its settings.
    await db().run([{ sql: "UPDATE apps SET tier = 'dispatch' WHERE app_slug = ?", params: ["crm"] }]);
    // todo's Worker deleted by hand: its names can't be listed.
    account.workers.delete(todoWorker);
    events = [];
    const before = account.cf.calls.length;

    await list(emptyDir());

    const lines = (done()!["message"] as string).split("\n");
    const table = lines.findIndex((line) => /^APP +SETTING +WHERE +STATUS$/.test(line));
    expect(lines.slice(table)).toEqual([
      "APP   SETTING                     WHERE    STATUS",
      "todo  OPENAI_API_KEY              Gateway  ! not set",
      "todo  DATAFORSEO_API_KEY          Gateway  ! not set",
      "todo  EMAIL_FROM+EMAIL_FROM_NAME  Gateway  ! not set",
      "todo  GITHUB_TOKEN                todo     ! not recorded",
      "todo  STRIPE_KEY                  todo     ! not recorded",
      "Couldn't list todo's secrets. Cloudflare said: This Worker does not exist on your account. [code: 10007]. They show as not recorded.",
    ]);
    // Its own names unknown, which never blocks: the command sets the Gateway's.
    expect(done()!["data"]["apps"]).toEqual([
      {
        id: "todo",
        setup: expect.objectContaining({
          ready: false,
          settings: expect.arrayContaining([expect.objectContaining({ id: "GITHUB_TOKEN", set: null })]),
          command: { command: "pnpm everyapp configure todo" },
        }),
      },
    ]);
    expect(account.cf.calls.slice(before).filter((call) => call.args.includes(crmWorker))).toEqual([]);
  });

  it("on a hosted Gateway, lists its own unset switches too", async () => {
    await writeInstall(db(), { ...(await readInstall(db()))!, deploymentMode: "hosted" });
    await list(emptyDir());
    const lines = (done()!["message"] as string).split("\n");
    for (const name of ["HOSTED_OPEN_SIGNUP", "DISPATCH_NAMESPACE", "THIRD_PARTY_DOMAIN"]) {
      expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^${name} +not set$`)));
    }
    expect(lines).toContain(`${SETTABLE_GATEWAY_SETTINGS.length - 3} more can be set; see docs/capabilities.md`);
  });

  it("in an app's directory, lists each setting with where it is held and whether it is set, and the one command that opens the app", async () => {
    const dir = appDir(TODO);
    const workerName = await deploy(dir, TODO);
    await set(dir, "GITHUB_TOKEN", "OPENAI_API_KEY");
    events = [];

    await list(dir);

    // everyapp's own names (EVERY_APP_ORG_ID, GATEWAY_URL) only with --verbose.
    expect(done()!["message"]).toBe(
      [
        "SETTING                     WHERE    STATUS",
        "OPENAI_API_KEY              Gateway  ✓ set",
        "DATAFORSEO_API_KEY          Gateway  ! not set",
        "EMAIL_FROM+EMAIL_FROM_NAME  Gateway  ! not set",
        "GITHUB_TOKEN                todo     ✓ set",
        "STRIPE_KEY                  todo     ! not set",
        "",
        // Each unmet setting as status describes it, with its guide once.
        "DataForSEO: DATAFORSEO_API_KEY",
        "Get it at https://app.dataforseo.com/api-access",
        "Guide: .claude/skills/everyapp/setup/dataforseo.md",
        "Email: EMAIL_FROM and EMAIL_FROM_NAME",
        "Guide: .claude/skills/everyapp/setup/email.md",
        "STRIPE_KEY",
      ].join("\n"),
    );
    expect(done()!["data"]).toMatchObject({
      app: {
        id: "todo",
        deployed: true,
        workerName,
        declared: ["GITHUB_TOKEN", "STRIPE_KEY"],
        // The Worker's names as they are (everyapp's own included), and
        // what it lacks: the shape the setup skills read.
        workers: [
          {
            workerName,
            names: expect.arrayContaining(["GITHUB_TOKEN", "EVERY_APP_ORG_ID", "GATEWAY_URL"]),
            missing: ["STRIPE_KEY"],
          },
        ],
        secretNames: ["GITHUB_TOKEN"],
        settings: expect.arrayContaining([
          expect.objectContaining({ id: "openai", set: true, blocking: false }),
          expect.objectContaining({ id: "dataforseo", set: false, blocking: true }),
          expect.objectContaining({ id: "STRIPE_KEY", holder: "app", set: false, blocking: true }),
        ]),
        setup: {
          ready: false,
          command: { command: "pnpm everyapp configure todo" },
        },
      },
      gateway: {
        workerName: GATEWAY,
        // Each Gateway name the app reads: required unless only read when set.
        needed: [
          { name: "OPENAI_API_KEY", required: true, set: true },
          { name: "DATAFORSEO_API_KEY", required: true, set: false },
          { name: "EMAIL_FROM", required: true, set: false },
          { name: "EMAIL_FROM_NAME", required: true, set: false },
          { name: "EMAIL_REST_API_TOKEN", required: false, set: false },
          { name: "RESEND_API_KEY", required: false, set: false },
          { name: "EMAIL_PROVIDER", required: false, set: false },
        ],
        missing: ["DATAFORSEO_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME"],
      },
      next: ["pnpm everyapp configure todo"],
    });
    expect(done()!["data"]["app"]["workers"]).toHaveLength(1);

    events = [];
    await listSecrets({ flags: { ...flags, verbose: true }, out: out(), cwd: dir, createCf });
    expect(done()!["message"]).toContain("EVERY_APP_ORG_ID            todo     ✓ set");
  });

  it("says which setting is optional, which is one of a group, and when a group is met, by name from anywhere", async () => {
    await deploy(appDir(CRM), CRM);
    const elsewhere = emptyDir();
    events = [];
    await list(elsewhere, "crm");
    expect(done()!["message"]).toBe(
      [
        "SETTING               WHERE    STATUS",
        "OPENAI_API_KEY        Gateway  ! not set",
        "OPENROUTER_API_KEY    Gateway  ! not set",
        "CONTEXT_API_KEY       Gateway  not set (optional)",
        "TOKEN_ENCRYPTION_KEY  crm      ! not set",
        "GITHUB_TOKEN          crm      not set (optional)",
        "",
        "OpenAI: OPENAI_API_KEY",
        "Get it at https://platform.openai.com/api-keys",
        "Guide: .claude/skills/everyapp/setup/openai.md",
        "OpenRouter: Any model through one key.",
        "Get it at https://openrouter.ai/settings/keys",
        "Guide: .claude/skills/everyapp/setup/openrouter.md",
        "TOKEN_ENCRYPTION_KEY: Encrypts the OAuth tokens it stores.",
      ].join("\n"),
    );
    // One of the group is enough: configure asks which.
    expect(done()!["data"]).toMatchObject({
      app: {
        setup: {
          ready: false,
          groups: [{ group: "AI model", met: false }],
          command: { command: "pnpm everyapp configure crm" },
        },
      },
      next: ["pnpm everyapp configure crm"],
    });

    await setFor("crm", elsewhere, "OPENROUTER_API_KEY", "TOKEN_ENCRYPTION_KEY");
    events = [];
    await list(elsewhere, "crm");
    expect(done()!["message"]).toBe(
      [
        "SETTING               WHERE    STATUS",
        "OPENAI_API_KEY        Gateway  not set (one of: AI model)",
        "OPENROUTER_API_KEY    Gateway  ✓ set",
        "CONTEXT_API_KEY       Gateway  not set (optional)",
        "TOKEN_ENCRYPTION_KEY  crm      ✓ set",
        "GITHUB_TOKEN          crm      not set (optional)",
      ].join("\n"),
    );
    expect(done()!["data"]).toMatchObject({
      app: { setup: { ready: true, command: null } },
      // A member of a met group is still one the app can't do without
      // (required), but its absence keeps nothing closed (not missing).
      gateway: {
        needed: [
          { name: "OPENAI_API_KEY", required: true, set: false },
          { name: "OPENROUTER_API_KEY", required: true, set: true },
          { name: "CONTEXT_API_KEY", required: false, set: false },
        ],
        missing: [],
      },
    });
    expect(done()!["data"]["next"]).toBeUndefined();

    await expect(list(elsewhere, "nope")).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
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
        "SETTING       WHERE         STATUS",
        "GITHUB_TOKEN  seo           ✓ set",
        "GITHUB_TOKEN  audit helper  ! not set",
      ].join("\n"),
    );
    expect(done()!["data"]["app"]["workers"]).toEqual([
      { workerName, names: expect.arrayContaining(["GITHUB_TOKEN"]), missing: [] },
      { workerName: helper, names: expect.not.arrayContaining(["GITHUB_TOKEN"]), missing: ["GITHUB_TOKEN"] },
    ]);
    expect(done()!["data"]["next"]).toBeUndefined();
  });

  it("says what a helper lacks in the app's own words: needed, optional, or one of a group", async () => {
    const manifest: EveryAppCliManifest = {
      ...SEO,
      secrets: [
        "GITHUB_TOKEN",
        { name: "SLACK_TOKEN", optional: true },
        { name: "PRIMARY_MODEL_KEY", anyOf: "AI key" },
        { name: "FALLBACK_MODEL_KEY", anyOf: "AI key" },
      ],
    };
    const dir = appDir(manifest);
    const workerName = await deploy(dir, manifest);
    const helper = account.workers.get(`${workerName}--audit`)!;
    // Set by hand on the app's Worker; the helper got only the one AI key.
    const own = account.workers.get(workerName)!;
    own.secrets = { ...own.secrets, GITHUB_TOKEN: "ghp", SLACK_TOKEN: "xoxb", PRIMARY_MODEL_KEY: "k1" };
    helper.secrets = { ...helper.secrets, PRIMARY_MODEL_KEY: "k1" };
    events = [];
    const row = (setting: string, where: string, status: string) =>
      `${setting.padEnd(18)}  ${where.padEnd(12)}  ${status}`;

    await list(dir);

    expect(done()!["message"]).toBe(
      [
        row("SETTING", "WHERE", "STATUS"),
        row("GITHUB_TOKEN", "seo", "✓ set"),
        row("SLACK_TOKEN", "seo", "✓ set"),
        row("PRIMARY_MODEL_KEY", "seo", "✓ set"),
        row("FALLBACK_MODEL_KEY", "seo", "not set (one of: AI key)"),
        row("GITHUB_TOKEN", "audit helper", "! not set"),
        row("SLACK_TOKEN", "audit helper", "not set (optional)"),
        row("PRIMARY_MODEL_KEY", "audit helper", "✓ set"),
        row("FALLBACK_MODEL_KEY", "audit helper", "not set (one of: AI key)"),
      ].join("\n"),
    );
    // What the helper lacks of every declared name, as the setup skills read it.
    expect(done()!["data"]["app"]["workers"][1]).toMatchObject({
      missing: ["GITHUB_TOKEN", "SLACK_TOKEN", "FALLBACK_MODEL_KEY"],
    });
    expect(done()!["data"]["next"]).toBeUndefined();

    // With no AI key on the helper at all, each member of the group is needed there.
    delete helper.secrets["PRIMARY_MODEL_KEY"];
    events = [];
    await list(dir);
    expect(done()!["message"]).toContain(row("PRIMARY_MODEL_KEY", "audit helper", "! not set"));
    expect(done()!["message"]).toContain(row("FALLBACK_MODEL_KEY", "audit helper", "! not set"));
  });

  it("in an app's directory before its first deploy, says so, and names the Gateway settings to set (from anywhere) before the deploy", async () => {
    await list(appDir(TODO));
    expect(done()!["message"]).toBe(
      [
        "SETTING                     WHERE    STATUS",
        "OPENAI_API_KEY              Gateway  ! not set",
        "DATAFORSEO_API_KEY          Gateway  ! not set",
        "EMAIL_FROM+EMAIL_FROM_NAME  Gateway  ! not set",
        "GITHUB_TOKEN                todo     after first deploy",
        "STRIPE_KEY                  todo     after first deploy",
        "",
        "OpenAI: OPENAI_API_KEY",
        "Get it at https://platform.openai.com/api-keys",
        "Guide: .claude/skills/everyapp/setup/openai.md",
        "DataForSEO: DATAFORSEO_API_KEY",
        "Get it at https://app.dataforseo.com/api-access",
        "Guide: .claude/skills/everyapp/setup/dataforseo.md",
        "Email: EMAIL_FROM and EMAIL_FROM_NAME",
        "Guide: .claude/skills/everyapp/setup/email.md",
        "",
        "todo isn't deployed yet; its own secrets can be set after that.",
      ].join("\n"),
    );
    // The app's own names wait for the deploy: `secret set STRIPE_KEY` would fail with APP_NOT_FOUND.
    expect(done()!["data"]).toMatchObject({
      app: { id: "todo", deployed: false, workerName: null, secretNames: null, workers: [] },
      gateway: { missing: ["OPENAI_API_KEY", "DATAFORSEO_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME"] },
      next: [
        // Configure sets the Gateway's names before the deploy, in the app's
        // directory (by name it is refused until then); the app's own wait.
        { command: "pnpm everyapp configure", note: "in the app's directory" },
        "pnpm everyapp deploy",
      ],
    });
  });

  it("before the first deploy of an app that needs no Gateway settings, the deploy is the one next command", async () => {
    await list(appDir(SEO));
    expect(done()!["message"]).toBe(
      [
        "SETTING       WHERE  STATUS",
        "GITHUB_TOKEN  seo    after first deploy",
        "",
        "seo isn't deployed yet; its own secrets can be set after that.",
      ].join("\n"),
    );
    expect(done()!["data"]).toMatchObject({
      app: { id: "seo", deployed: false },
      gateway: { needed: [], missing: [] },
      next: ["pnpm everyapp deploy"],
    });
  });

  it("says an app that declares no secrets and needs no Gateway settings has nothing to set, deployed or not", async () => {
    const message = "notes declares no secrets and needs no Gateway settings.";
    const dir = appDir(NOTES);
    await list(dir);
    expect(done()).toMatchObject({ message, data: { app: { id: "notes", deployed: false, declared: [] } } });
    expect(done()!["data"]["next"]).toBeUndefined();

    const workerName = await deploy(dir, NOTES);
    await list(dir);
    expect(done()).toMatchObject({ message, data: { app: { id: "notes", deployed: true, workerName } } });
    expect(done()!["data"]["next"]).toBeUndefined();
  });

  it("treats a registered app whose deploy never finished as undeployed", async () => {
    await register(db(), {
      appSlug: "todo",
      name: "todo",
      description: "todo",
      manifest: TODO,
      appBaseDomain: "example.com",
      deployer: { actor: "dev@example.com", email: "dev@example.com" },
      organizationName: "Acme",
    });
    await list(emptyDir(), "todo");
    expect(done()!["message"]).toContain("GITHUB_TOKEN                todo     after first deploy");
    expect(done()!["data"]).toMatchObject({
      app: { deployed: false },
      next: [{ command: "pnpm everyapp configure", note: "in the app's directory" }, "pnpm everyapp deploy"],
    });
  });
});
