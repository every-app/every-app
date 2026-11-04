/**
 * `everyapp access on|off|show` end to end, in a fake Cloudflare account
 * with a deployed gateway (as secret/index.test.ts): from nothing to a team,
 * both sign-in methods (a Cloudflare account, a PIN), the policy that asks
 * the Gateway who is a member, two applications and the Gateway's
 * settings; a rerun that changes nothing; the apps' public routes, which
 * deploy and delete keep current by running the same recipe; what the
 * command leaves alone; and the way back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccessOffChoice } from "@/lib/access/record";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readApp } from "@/lib/gateway/registry";
import { GATEWAY_SCHEMA } from "@/lib/gateway/schema";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "../deploy/deployApp";
import { removeApp } from "../delete";
import { ACCESS_SETTINGS } from "@/lib/access/settings";
import { PROTECTED_RESOURCE_METADATA_PATH } from "@/lib/access/plan";
import { POLICY_NAME, showAccess, turnAccessOff, turnAccessOn } from "./index";

const GATEWAY = "every-app-gateway";
const HOST = "example.com";
const NOW = Date.now();

/** An app with public routes, like the CRM: a tracking pixel, an event endpoint, a health check, and a bearer API. */
const CRM: EveryAppCliManifest = {
  id: "crm",
  resources: { d1: ["DB"] },
  public: [
    { path: "/t/*", methods: ["GET"] },
    { path: "/t/e", methods: ["POST"] },
    { path: "/health", methods: ["GET"] },
    { path: "/api/**", bearer: true },
  ],
};

/** An app with none. */
const TODO: EveryAppCliManifest = { id: "todo", resources: { d1: ["DB"] } };

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
const dirs: string[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const gatewayWorker = () => account.workers.get(GATEWAY)!;
const done = () => events.find((event) => event["type"] === "done");
const error = () => events.find((event) => event["type"] === "error");
const warnings = (code: string) => events.filter((event) => event["type"] === "warning" && event["code"] === code);
const zt = () => account.zeroTrust;
const applications = () => [...zt().applications.values()];
const application = (uri: string) =>
  applications().find((app) => (app["destinations"] as Array<{ uri: string }>).some((d) => d.uri === uri));
const uris = (app: Record<string, any>) => (app["destinations"] as Array<{ uri: string }>).map((d) => d.uri);
const overrides = (app: Record<string, any>, uri: string) =>
  (app["destinations"] as Array<{ uri: string; overrides: Array<{ path_pattern: string }> }>)
    .find((d) => d.uri === uri)!
    .overrides.map((o) => o.path_pattern);
const policy = () => [...zt().policies.values()].find((p) => p["name"] === POLICY_NAME);
const provider = (type: string) => [...zt().identityProviders.values()].find((p) => p["type"] === type);
/** Zero Trust writes this run made. */
const writes = () =>
  account.cf.calls.filter(
    (call) =>
      call.args[0] === "zero-trust" &&
      call.args.some((arg) => arg === "create" || arg === "update" || arg === "delete"),
  );

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
    gatewayHost: HOST,
    zone: { id: "zone-1", name: HOST },
    appBaseDomain: HOST,
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

/** The Gateway's people: an owner and an admin with passwords, one who linked Access already, one deactivated. */
async function seedPeople(): Promise<void> {
  const org = "org-1";
  await db().run([
    {
      sql: "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES (?, 'Acme', 'acme', ?)",
      params: [org, NOW],
    },
    ...[
      ["u-ben", "Ben", "ben@acme.com", 0],
      ["u-jo", "Jo", "jo@acme.com", 0],
      ["u-linked", "Linked", "linked@acme.com", 0],
      ["u-gone", "Gone", "gone@acme.com", 1],
    ].map(([id, name, email, banned]) => ({
      sql: "INSERT INTO users (id, name, email, banned) VALUES (?, ?, ?, ?)",
      params: [id as string, name as string, email as string, banned as number],
    })),
    ...["u-ben", "u-jo", "u-linked", "u-gone"].map((id) => ({
      sql: "INSERT INTO accounts (id, account_id, provider_id, user_id, updated_at) VALUES (?, ?, 'credential', ?, ?)",
      params: [`acc-${id}`, id, id, NOW],
    })),
    {
      sql: "INSERT INTO accounts (id, account_id, provider_id, user_id, updated_at) VALUES ('acc-linked-access', 'linked@acme.com', 'cloudflare-access', 'u-linked', ?)",
      params: [NOW],
    },
    ...["u-ben", "u-jo", "u-linked", "u-gone"].map((id, index) => ({
      sql: "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      params: [`m-${id}`, org, id, index === 0 ? "owner" : "member", NOW],
    })),
    // Invitations: one pending, one expired, one accepted.
    {
      sql: "INSERT INTO invitations (id, organization_id, email, status, expires_at, inviter_id) VALUES ('inv-sam', ?, 'sam@acme.com', 'pending', ?, 'u-ben')",
      params: [org, NOW + 3_600_000],
    },
    {
      sql: "INSERT INTO invitations (id, organization_id, email, status, expires_at, inviter_id) VALUES ('inv-old', ?, 'old@acme.com', 'pending', ?, 'u-ben')",
      params: [org, NOW - 1],
    },
    {
      sql: "INSERT INTO invitations (id, organization_id, email, status, expires_at, inviter_id) VALUES ('inv-done', ?, 'done@acme.com', 'accepted', ?, 'u-ben')",
      params: [org, NOW + 3_600_000],
    },
  ]);
}

/** An app's directory: its real everyapp.config.ts, and what the fake build needs. */
function appDir(manifest: EveryAppCliManifest): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-access-app-"));
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
  fs.writeFileSync(path.join(dir, "drizzle", "0000_init.sql"), "CREATE TABLE todos (id text PRIMARY KEY, title text);");
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
  return (await readApp(db(), manifest.id)).workerName;
}

function remove(appId: string) {
  return removeApp({
    appId,
    out: out(),
    interactive: false,
    purge: false,
    createCf: () => account.cf,
    reconcile: {
      ...seams,
      openRelease: () => openRelease(tarball),
      source: () => releaseSource(tarball),
    },
  });
}

const createCf = () => account.cf;
const flags = { json: true };

function on(options: Partial<Parameters<typeof turnAccessOn>[0]> = {}) {
  events = [];
  account.cf.calls.length = 0;
  return turnAccessOn({ flags, out: out(), createCf, ...options });
}
function off(options: Partial<Parameters<typeof turnAccessOff>[0]> = {}) {
  events = [];
  account.cf.calls.length = 0;
  return turnAccessOff({ flags: { ...flags, yes: true }, out: out(), createCf, ...options });
}
function show() {
  events = [];
  return showAccess({ flags, out: out(), createCf });
}

/** The policy's one rule: Access asks the Gateway who is a member. */
const EVALUATION = {
  external_evaluation: {
    evaluate_url: `https://${HOST}/access-evaluation/evaluate`,
    keys_url: `https://${HOST}/access-evaluation/keys`,
  },
};

describe("access on, from nothing", () => {
  it("refuses until the Gateway has an owner, before anything is made", async () => {
    await expect(on({ team: "acme" })).rejects.toMatchObject({ code: "ACCESS_NOBODY_ALLOWED" });
    expect(zt().organization).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("refuses on a Gateway that can't answer Access's membership question yet, before anything is made", async () => {
    await seedPeople();
    // The membership check needs the Gateway's newest migration: the one version check refuses it first.
    await db().run([{ sql: "DELETE FROM d1_migrations WHERE name = ?", params: [`${GATEWAY_SCHEMA}.sql`] }]);
    await expect(on({ team: "acme" })).rejects.toMatchObject({
      code: "GATEWAY_OUTDATED",
      rerun: "pnpm everyapp update",
    });
    expect(zt().organization).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("refuses without --team when the account has no Zero Trust team, before anything is made", async () => {
    await seedPeople();
    await expect(on()).rejects.toMatchObject({
      code: "ACCESS_TEAM_REQUIRED",
      fix: "add --team example, or another name",
      data: { suggested: "example" },
    });
    expect(zt().organization).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("creates the team, both sign-in methods, the policy that asks the Gateway, both applications and the settings, in one Worker version", async () => {
    await seedPeople();
    const versions = gatewayWorker().versions.length;

    await on({ team: "acme" });

    expect(error()).toBeUndefined();
    expect(zt().organization).toMatchObject({ auth_domain: "acme.cloudflareaccess.com", session_duration: "720h" });
    // The two ways to sign in: a Cloudflare account (this account's members only), and a code by email.
    expect([...zt().identityProviders.values()]).toHaveLength(2);
    const cloudflare = provider("cloudflare")!;
    const pin = provider("onetimepin")!;
    expect(cloudflare).toMatchObject({ name: "Cloudflare", config: { restrict_to_account_members: true } });
    // Who gets in is the Gateway's answer: one External Evaluation rule, no email list.
    expect(policy()).toMatchObject({ decision: "allow", include: [EVALUATION] });
    const gateway = application(HOST)!;
    const apps = application(`*.${HOST}`)!;
    expect(gateway["id"]).not.toBe(apps["id"]);
    expect(overrides(gateway, HOST)).toEqual([
      "/mcp",
      "/mcp/*",
      "/oauth/token",
      "/oauth/register",
      "/linked-dev/*",
      "/.well-known/*",
      "/health",
      "/api/auth/callback/apple",
      "/access-evaluation/*",
    ]);
    expect(uris(apps)).toEqual([`*.${HOST}`]);
    expect(overrides(apps, `*.${HOST}`)).toEqual([]);
    for (const app of [gateway, apps]) {
      expect(app).toMatchObject({
        type: "self_hosted",
        policies: [policy()!["id"]],
        session_duration: "720h",
        http_only_cookie_attribute: true,
        enable_binding_cookie: true,
        allowed_idps: [cloudflare["id"], pin["id"]],
        auto_redirect_to_identity: false,
      });
    }
    expect(gateway["app_launcher_visible"]).toBe(true);
    expect(apps["app_launcher_visible"]).toBe(false);
    expect(gatewayWorker().secrets).toMatchObject({
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
      CLOUDFLARE_ACCESS_AUD: gateway["aud"],
      CLOUDFLARE_ACCESS_APPS_AUD: apps["aud"],
    });
    expect(gatewayWorker().versions).toHaveLength(versions + 1);
    expect(done()).toMatchObject({
      data: {
        team: { domain: "acme.cloudflareaccess.com", created: true },
        signInMethods: [
          { type: "cloudflare", restrictToAccountMembers: true, allowed: true },
          { type: "onetimepin", allowed: true },
        ],
        policy: { name: POLICY_NAME, outcome: "created" },
        applications: {
          gateway: { aud: gateway["aud"], outcome: "created" },
          apps: { aud: apps["aud"], outcome: "created" },
          combined: false,
        },
        settings: { names: [...ACCESS_SETTINGS] },
        signIn: { url: `https://${HOST}` },
      },
    });
    expect(done()!["message"]).toContain("invite someone in Manage workspace → Users and they can sign in at once");
  });

  it("creates the team on an account that never opened Zero Trust, then everything else", async () => {
    await seedPeople();
    account.accessNotEnabled = true;

    await on({ team: "acme" });

    expect(error()).toBeUndefined();
    expect(zt().organization).toMatchObject({ auth_domain: "acme.cloudflareaccess.com" });
    expect(provider("cloudflare")).toBeDefined();
    expect(provider("onetimepin")).toBeDefined();
    expect(application(HOST)).toBeDefined();
  });

  it("keeps a team's Cloudflare provider, adds the PIN beside it, and allows both on the applications", async () => {
    await seedPeople();
    zt().organization = { name: "acme", auth_domain: "acme.cloudflareaccess.com", session_duration: "24h", created_at: 0 };
    zt().identityProviders.set("idp-cf", { id: "idp-cf", type: "cloudflare", name: "Cloudflare account members", config: { restrict_to_account_members: true } });

    await on();

    expect(error()).toBeUndefined();
    expect([...zt().identityProviders.values()].map((p) => p["type"])).toEqual(["cloudflare", "onetimepin"]);
    expect(application(HOST)!["allowed_idps"]).toEqual(["idp-cf", provider("onetimepin")!["id"]]);
    // The team's own session is left as it was.
    expect(zt().organization).toMatchObject({ session_duration: "24h" });
  });

  it("changes nothing in Access on a second run, and queues no event for it", async () => {
    await seedPeople();
    await on({ team: "acme" });

    await on();

    expect(error()).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(done()).toMatchObject({
      data: { team: { created: false }, policy: { outcome: "unchanged" }, applications: { gateway: { outcome: "unchanged" }, apps: { outcome: "unchanged" } } },
    });
  });

  it("replaces a policy's email list with the Gateway's answer, so invitations need no rerun", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const found = policy()!;
    found["include"] = [{ email: { email: "ben@acme.com" } }, { email_domain: { domain: "acme.com" } }];

    await on();

    expect(policy()).toMatchObject({ id: found["id"], include: [EVALUATION] });
    expect(done()).toMatchObject({ data: { policy: { outcome: "updated" } } });
  });

  it("writes the settings again when an application was recreated by hand", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const old = application(`*.${HOST}`)!;
    zt().applications.delete(old["id"] as string);

    await on();

    const recreated = application(`*.${HOST}`)!;
    expect(recreated["aud"]).not.toBe(old["aud"]);
    expect(gatewayWorker().secrets["CLOUDFLARE_ACCESS_APPS_AUD"]).toBe(recreated["aud"]);
  });

  it("ignores --team once a team exists", async () => {
    await seedPeople();
    await on({ team: "acme" });
    await on({ team: "NOT A NAME" });
    expect(error()).toBeUndefined();
    expect(zt().organization).toMatchObject({ auth_domain: "acme.cloudflareaccess.com" });
  });

  it("keeps what it didn't make: a destination for something else, another policy, and a sign-in method the operator allowed", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const apps = application(`*.${HOST}`)!;
    (apps["destinations"] as unknown[]).unshift({ type: "public", uri: "wiki.example.org", overrides: [] });
    zt().identityProviders.set("idp-okta", { id: "idp-okta", type: "okta", name: "Okta", config: {} });
    apps["allowed_idps"] = [...(apps["allowed_idps"] as string[]), "idp-okta"];
    zt().policies.set("monitor", { id: "monitor", name: "Uptime monitor", decision: "non_identity", include: [], exclude: [], require: [], reusable: true });
    apps["policies"] = ["monitor", policy()!["id"]];
    apps["enable_binding_cookie"] = false;

    await on();

    expect(error()).toBeUndefined();
    const after = application(`*.${HOST}`)!;
    expect(uris(after)).toEqual(["wiki.example.org", `*.${HOST}`]);
    expect(after["policies"]).toEqual(["monitor", policy()!["id"]]);
    expect(after["allowed_idps"]).toEqual(expect.arrayContaining(["idp-okta"]));
    expect(after["enable_binding_cookie"]).toBe(true);
    expect(done()).toMatchObject({ data: { applications: { apps: { outcome: "updated" } } } });
  });
});

describe("access on and the apps' public routes", { timeout: 30_000 }, () => {
  const accessSteps = () => events.filter((event) => event["type"] === "step" && event["step"] === "app.access");
  const accessWarnings = () => events.filter((event) => event["type"] === "warning" && String(event["code"]).startsWith("ACCESS_"));
  const zeroTrustCalls = () => account.cf.calls.filter((call) => call.args[0] === "zero-trust");

  it("lets every served app's public and bearer routes through; a redeploy with the same routes calls nothing in Zero Trust", async () => {
    await seedPeople();
    await deploy(appDir(CRM), CRM);

    await on({ team: "acme" });

    expect(error()).toBeUndefined();
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`, `crm.${HOST}`]);
    expect(overrides(application(`*.${HOST}`)!, `crm.${HOST}`)).toEqual([
      PROTECTED_RESOURCE_METADATA_PATH,
      "/api/*",
      "/t/*",
      "/t/e",
      "/health",
    ]);

    events = [];
    account.cf.calls.length = 0;
    await deploy(appDir(TODO), TODO);
    expect(accessSteps()).toEqual([]);
    expect(zeroTrustCalls()).toEqual([]);
  });

  it("lets a deploy's new public routes through by itself while Access is on, with one line and no warning", async () => {
    await seedPeople();
    await on({ team: "acme" });
    events = [];

    await deploy(appDir(CRM), CRM);

    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`, `crm.${HOST}`]);
    expect(accessSteps()).toContainEqual(
      expect.objectContaining({ status: "ok", message: "Cloudflare Access updated for crm's public routes", data: { appId: "crm", changed: true } }),
    );
    expect(accessWarnings()).toEqual([]);
  });

  it("takes a deleted app's public routes back out by itself; an app without any goes quietly", async () => {
    await seedPeople();
    await deploy(appDir(CRM), CRM);
    await deploy(appDir(TODO), TODO);
    await on({ team: "acme" });
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`, `crm.${HOST}`]);

    events = [];
    account.cf.calls.length = 0;
    await remove("todo");
    expect(accessSteps()).toEqual([]);
    expect(zeroTrustCalls()).toEqual([]);

    events = [];
    await remove("crm");
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`]);
    expect(accessSteps()).toContainEqual(expect.objectContaining({ status: "ok", data: { appId: "crm", changed: true } }));
  });

  it("does nothing about Access on a deploy while Access is off", async () => {
    await seedPeople();
    await deploy(appDir(CRM), CRM);
    expect(accessSteps()).toEqual([]);
    expect(zeroTrustCalls()).toEqual([]);
  });

  it("still deploys when Access can't be edited, with one warning naming access on", async () => {
    await seedPeople();
    await on({ team: "acme" });
    events = [];
    account.cf.override(["zero-trust", "organization", "get"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [10000] Authentication error\n└\n",
    });

    await deploy(appDir(CRM), CRM);

    expect(error()).toBeUndefined();
    expect(await readApp(db(), "crm")).toMatchObject({ status: "active" });
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`]);
    expect(accessWarnings()).toEqual([
      expect.objectContaining({
        code: "ACCESS_UPDATE_FAILED",
        step: "app.access",
        message: expect.stringContaining("Cloudflare Access wasn't updated for crm's public routes"),
        data: expect.objectContaining({ appId: "crm", rerun: expect.stringContaining("access on") }),
      }),
    ]);
  });
});

describe("access show", () => {
  it("says off, then on, and that the policy asks the Gateway", async () => {
    await seedPeople();
    await show();
    expect(done()).toMatchObject({ data: { on: false, team: null, fixes: [expect.stringContaining("access on")] } });

    await on({ team: "acme" });
    await show();
    expect(done()).toMatchObject({
      data: {
        on: true,
        team: { domain: "acme.cloudflareaccess.com" },
        policy: { name: POLICY_NAME, asksGateway: true },
        applications: { gateway: { aud: application(HOST)!["aud"] }, apps: { aud: application(`*.${HOST}`)!["aud"] }, combined: false },
        settings: { names: [...ACCESS_SETTINGS] },
      },
    });
    expect(done()!["data"]["fixes"]).toBeUndefined();

    // A policy changed by hand back to an email list no longer asks the Gateway.
    policy()!["include"] = [{ email: { email: "ben@acme.com" } }];
    await show();
    expect(done()).toMatchObject({ data: { policy: { asksGateway: false }, fixes: [expect.stringContaining("access on")] } });
  });
});

describe("access off", () => {
  it("removes the settings in one version, deletes the applications, and leaves the team and policy", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const versions = gatewayWorker().versions.length;

    await off();

    expect(error()).toBeUndefined();
    for (const name of ACCESS_SETTINGS) expect(gatewayWorker().secrets[name]).toBeUndefined();
    expect(gatewayWorker().versions).toHaveLength(versions + 1);
    expect(applications()).toEqual([]);
    expect(zt().organization).not.toBeNull();
    expect(policy()).toBeDefined();
    expect(zt().identityProviders.size).toBe(2);
    expect(done()).toMatchObject({ data: { removed: true, settings: [...ACCESS_SETTINGS], applications: { trimmed: [] } } });

    // Twice: nothing to do, no new version.
    await off();
    expect(done()).toMatchObject({ data: { removed: false } });
    expect(gatewayWorker().versions).toHaveLength(versions + 1);
  });

  it("only takes our hosts out of an application that also covers something else", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const apps = application(`*.${HOST}`)!;
    (apps["destinations"] as unknown[]).push({ type: "public", uri: "wiki.example.org", overrides: [] });

    await off();
    expect(applications()).toHaveLength(1);
    expect(uris(applications()[0]!)).toEqual(["wiki.example.org"]);
    expect(done()).toMatchObject({ data: { applications: { trimmed: [apps["id"]] } } });
  });

  it("asks first, and refuses unattended without --yes", async () => {
    await seedPeople();
    await on({ team: "acme" });
    events = [];
    await expect(turnAccessOff({ flags, out: out(), createCf, interactive: false })).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      authorize: true,
      rerun: expect.stringContaining("--yes"),
    });
    expect(applications()).toHaveLength(2);

    events = [];
    const confirm = vi.fn(async () => false);
    await expect(turnAccessOff({ flags, out: out(), createCf, interactive: true, confirm })).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Cancelled. Access stays on.",
    });
    expect(confirm).toHaveBeenCalledWith(
      `Turn Cloudflare Access off for ${HOST}?`,
      expect.arrayContaining([expect.stringContaining("Deletes 2 Access applications")]),
    );
    expect(applications()).toHaveLength(2);
  });
});

describe("the access.changed events", () => {
  const queued = async () =>
    ((await db().run([{ sql: "SELECT organization_id, type, actor, data FROM events ORDER BY rowid" }]))[0] ?? []).map((row) => ({
      organization: row["organization_id"],
      type: row["type"],
      actor: JSON.parse(String(row["actor"])),
      data: JSON.parse(String(row["data"])),
    }));

  it("queues one when on changes Access and one when off removes it, never on a run that changes nothing", async () => {
    await seedPeople();
    await db().run([
      {
        sql: "INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, events, created_at, updated_at) VALUES ('sub_1', 'org-1', 'Slack', 'webhook', 'https://hooks.example.org/x', 'whsec_x', '[\"access.*\"]', 0, 0)",
      },
    ]);
    await on({ team: "acme" });
    await on();
    expect(await readAccessOffChoice(db())).toBeNull();
    await off();
    // Off on purpose: an unattended setup won't put it back on.
    expect(await readAccessOffChoice(db())).toBe("access-off");
    await off();

    expect(await queued()).toEqual([
      {
        organization: "org-1",
        type: "access.changed",
        actor: { kind: "operator", id: "dev@example.com", email: "dev@example.com" },
        data: { access: "on", teamDomain: "acme.cloudflareaccess.com" },
      },
      expect.objectContaining({ type: "access.changed", data: { access: "off" } }),
    ]);
    const [deliveries = []] = await db().run([{ sql: "SELECT subscription_id, status FROM event_deliveries" }]);
    expect(deliveries).toEqual([
      { subscription_id: "sub_1", status: "pending" },
      { subscription_id: "sub_1", status: "pending" },
    ]);
  });
});
