/**
 * `everyapp access on|off|show` end to end, in a fake Cloudflare account
 * with a deployed gateway (as secret/index.test.ts): from nothing to a team,
 * a PIN, a policy, two applications and the Gateway's settings; a rerun
 * that changes nothing; a deploy and a delete keeping the apps application
 * in step; what the command leaves alone; and the way back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import type { RecordedCfCall } from "@/lib/cf/fakeCf";
import { applyGateway } from "@/lib/gateway/apply";
import { readApp } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { removeApp } from "../delete";
import { deployApp } from "../deploy/deployApp";
import { ACCESS_SETTINGS } from "@/lib/access/settings";
import { POLICY_NAME, showAccess, turnAccessOff, turnAccessOn } from "./index";

const GATEWAY = "every-app-gateway";
const HOST = "example.com";
const NOW = Date.parse("2026-10-23T12:00:00Z");

/** An app with public routes, like the CRM: a tracking pixel, an event endpoint, a health check. */
const CRM: EveryAppCliManifest = {
  id: "crm",
  resources: { d1: ["DB"] },
  public: [
    { path: "/t/*", methods: ["GET"] },
    { path: "/t/e", methods: ["POST"] },
    { path: "/health", methods: ["GET"] },
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
const steps = (step: string) => events.filter((event) => event["type"] === "step" && event["step"] === step);
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
const policyEmails = () =>
  ((policy()?.["include"] ?? []) as Array<{ email?: { email: string } }>).flatMap((r) => (r.email ? [r.email.email] : []));
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

const createCf = () => account.cf;
const flags = { json: true };

function on(options: Partial<Parameters<typeof turnAccessOn>[0]> = {}) {
  events = [];
  account.cf.calls.length = 0;
  return turnAccessOn({ flags, out: out(), createCf, now: () => NOW, ...options });
}
function off(options: Partial<Parameters<typeof turnAccessOff>[0]> = {}) {
  events = [];
  account.cf.calls.length = 0;
  return turnAccessOff({ flags: { ...flags, yes: true }, out: out(), createCf, ...options });
}
function show() {
  events = [];
  return showAccess({ flags, out: out(), createCf, now: () => NOW });
}

describe("access on, from nothing", () => {
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

  it("refuses when nobody would be let in, before anything is made", async () => {
    await expect(on({ team: "acme" })).rejects.toMatchObject({ code: "ACCESS_NOBODY_ALLOWED" });
    expect(zt().organization).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("creates the team, the PIN, the policy, both applications and the settings, in one Worker version", async () => {
    await seedPeople();
    const versions = gatewayWorker().versions.length;

    await on({ team: "acme" });

    expect(error()).toBeUndefined();
    // The team, with the session the applications get.
    expect(zt().organization).toMatchObject({ auth_domain: "acme.cloudflareaccess.com", session_duration: "720h" });
    // The one way to sign in.
    const pin = [...zt().identityProviders.values()];
    expect(pin).toHaveLength(1);
    expect(pin[0]).toMatchObject({ type: "onetimepin" });
    // Members who aren't deactivated, and the pending unexpired invitee.
    expect(policyEmails()).toEqual(["ben@acme.com", "jo@acme.com", "linked@acme.com", "sam@acme.com"]);
    expect(policy()).toMatchObject({ decision: "allow" });
    // The two applications.
    const gateway = application(HOST)!;
    const apps = application(`*.${HOST}`)!;
    expect(gateway["id"]).not.toBe(apps["id"]);
    expect(overrides(gateway, HOST)).toEqual(["/mcp", "/mcp/*", "/oauth/token", "/oauth/register", "/.well-known/*"]);
    expect(uris(apps)).toEqual([`*.${HOST}`]);
    expect(overrides(apps, `*.${HOST}`)).toEqual(["/mcp", "/mcp/*"]);
    for (const app of [gateway, apps]) {
      expect(app).toMatchObject({
        type: "self_hosted",
        policies: [policy()!["id"]],
        session_duration: "720h",
        http_only_cookie_attribute: true,
        enable_binding_cookie: true,
        allowed_idps: [pin[0]!["id"]],
        auto_redirect_to_identity: true,
      });
    }
    expect(gateway["app_launcher_visible"]).toBe(true);
    expect(apps["app_launcher_visible"]).toBe(false);
    // The Gateway's settings, one new version.
    expect(gatewayWorker().secrets).toMatchObject({
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
      CLOUDFLARE_ACCESS_AUD: gateway["aud"],
      CLOUDFLARE_ACCESS_APPS_AUD: apps["aud"],
    });
    expect(gatewayWorker().versions).toHaveLength(versions + 1);
    expect(done()).toMatchObject({
      data: {
        team: { domain: "acme.cloudflareaccess.com", created: true },
        identityProviders: { oneTimePinAdded: true },
        policy: { name: POLICY_NAME, created: true },
        applications: {
          gateway: { aud: gateway["aud"], outcome: "created" },
          apps: { aud: apps["aud"], outcome: "created" },
          combined: false,
        },
        settings: { names: [...ACCESS_SETTINGS], outcome: "set", reason: "missing" },
        // Who signs in with a password once: not the one who linked already, not the deactivated.
        signIn: { url: `https://${HOST}`, pending: ["ben@acme.com", "jo@acme.com"], first: "pin" },
        next: [{ command: expect.stringContaining("secret set EMAIL_PASSWORD_SIGN_IN") }],
      },
    });
    expect(done()!["message"]).toContain("ben@acme.com and jo@acme.com sign in once");
  });

  it("does nothing on a second run", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const versions = gatewayWorker().versions.length;

    await on();

    expect(error()).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(gatewayWorker().versions).toHaveLength(versions);
    expect(done()).toMatchObject({
      data: {
        team: { created: false, sessionSet: null },
        policy: { created: false, added: [] },
        applications: { gateway: { outcome: "unchanged" }, apps: { outcome: "unchanged" } },
        settings: { outcome: "kept" },
      },
    });
    expect(done()!["message"]).toContain("Gateway settings kept");
  });

  it("adds a new invitee or --email to the policy, warns about an address with no account, and never removes anyone", async () => {
    await seedPeople();
    await on({ team: "acme" });
    // A rule added by hand in the dashboard, and a new invitation.
    const found = policy()!;
    (found["include"] as unknown[]).push({ group: { id: "g-1" } });
    // Settings made in the dashboard, which a PUT without them would reset.
    found["approval_required"] = true;
    found["session_duration"] = "2h";
    await db().run([
      {
        sql: "INSERT INTO invitations (id, organization_id, email, status, expires_at, inviter_id) VALUES ('inv-new', 'org-1', 'New@Acme.com', 'pending', ?, 'u-ben')",
        params: [NOW + 1000],
      },
    ]);

    await on({ emails: ["Ana@Example.org"], emailDomains: ["partners.example"] });

    expect(policyEmails()).toEqual(["ben@acme.com", "jo@acme.com", "linked@acme.com", "sam@acme.com", "new@acme.com", "ana@example.org"]);
    expect(policy()!["include"]).toContainEqual({ group: { id: "g-1" } });
    expect(policy()!["include"]).toContainEqual({ email_domain: { domain: "partners.example" } });
    expect(policy()).toMatchObject({ approval_required: true, session_duration: "2h" });
    expect(warnings("ACCESS_EMAIL_NOT_INVITED")[0]).toMatchObject({ data: { emails: ["ana@example.org"] } });
    expect(done()).toMatchObject({
      data: {
        policy: { added: ["new@acme.com", "ana@example.org", "@partners.example"] },
        next: [
          { command: expect.stringContaining("CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS") },
          { command: expect.stringContaining("EMAIL_PASSWORD_SIGN_IN") },
        ],
      },
    });
  });

  it("writes the settings again when an application was recreated by hand, whatever the Gateway deployed since", async () => {
    await seedPeople();
    await on({ team: "acme" });
    // The gateway application recreated by hand: same destination, new AUD.
    const old = application(HOST)!;
    zt().applications.delete(old["id"] as string);
    zt().applications.set("app-new", { ...old, id: "app-new", aud: "f".repeat(64), created_at: account.clock() });
    // Then a Gateway version newer than it (a deploy): no timestamp tells the two apart.
    await deploy(appDir(TODO), TODO);
    const versions = gatewayWorker().versions.length;

    await show();
    expect(done()).toMatchObject({ data: { on: true, settings: { current: false }, fixes: [expect.stringContaining("access on")] } });

    await on();

    expect(gatewayWorker().secrets["CLOUDFLARE_ACCESS_AUD"]).toBe("f".repeat(64));
    expect(gatewayWorker().versions).toHaveLength(versions + 1);
    expect(done()).toMatchObject({ data: { settings: { outcome: "set", reason: "changed" } } });
    expect(done()!["message"]).toContain("AUD tag had changed");

    await show();
    expect(done()).toMatchObject({ data: { settings: { current: true } } });
    expect(done()!["data"]["fixes"]).toBeUndefined();
  });

  it("ignores --team once a team exists, and checks it only when one is made", async () => {
    await seedPeople();
    await expect(on({ team: "Not A Name" })).rejects.toMatchObject({ code: "ACCESS_TEAM_INVALID" });
    expect(zt().organization).toBeNull();

    await on({ team: "acme" });
    await on({ team: "Not A Name" });

    expect(error()).toBeUndefined();
    expect(zt().organization).toMatchObject({ auth_domain: "acme.cloudflareaccess.com" });
  });

  it("reads the apps' public routes under the Access lease, so a deploy finishing meanwhile isn't undone", async () => {
    await seedPeople();
    await on({ team: "acme" });

    await on();

    const sql = (call: RecordedCfCall) => Object.values(call.files).join(" ");
    const lease = account.cf.calls.findIndex((call) => sql(call).includes("INSERT INTO _everyapp_deploy_lease"));
    const routes = account.cf.calls.findIndex((call) => sql(call).includes("FROM apps"));
    expect(lease).toBeGreaterThan(-1);
    expect(routes).toBeGreaterThan(lease);
  });

  it("says a refusal from Workers as cf's, not as missing Access permissions", async () => {
    await seedPeople();
    account.cf.override(["workers", "secrets", "bulk"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [10000] Authentication error\n└\n",
    });

    const failure: unknown = await on({ team: "acme" }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: "auth" });
    expect(failure).not.toMatchObject({ code: "ACCESS_PERMISSION_MISSING" });

    // A refusal from Access is.
    account.cf.override(["zero-trust", "access", "applications", "list"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [10000] Authentication error\n└\n",
    });
    await expect(on()).rejects.toMatchObject({ code: "ACCESS_PERMISSION_MISSING" });
  });

  it("keeps what it didn't make: a destination for something else, and an application's own policies", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const apps = application(`*.${HOST}`)!;
    (apps["destinations"] as unknown[]).unshift({ type: "public", uri: "wiki.example.org", overrides: [] });
    const gateway = application(HOST)!;
    zt().policies.set("inline-1", { id: "inline-1", name: "Hand-made", decision: "allow", include: [], exclude: [], require: [], reusable: false });
    gateway["policies"] = ["inline-1"];
    // Something ours to put right, so each application is PUT once.
    (gateway["destinations"] as Array<{ overrides: unknown[] }>)[0]!.overrides = [];
    (apps["destinations"] as Array<{ uri: string; overrides: unknown[] }>).find((d) => d.uri === `*.${HOST}`)!.overrides = [];

    await on();

    expect(error()).toBeUndefined();
    expect(uris(application(`*.${HOST}`)!)).toEqual(["wiki.example.org", `*.${HOST}`]);
    expect(overrides(application(`*.${HOST}`)!, `*.${HOST}`)).toEqual(["/mcp", "/mcp/*"]);
    expect(warnings("ACCESS_FOREIGN_DESTINATION")[0]).toMatchObject({ data: { uris: ["wiki.example.org"] } });
    // The application with policies of its own is left alone, paths and all.
    expect(application(HOST)!["policies"]).toEqual(["inline-1"]);
    expect(overrides(application(HOST)!, HOST)).toEqual([]);
    expect(warnings("ACCESS_INLINE_POLICIES")).toHaveLength(1);
    expect(done()).toMatchObject({ data: { applications: { gateway: { outcome: "skipped" }, apps: { outcome: "updated" } } } });
    // The destination for something else isn't an app with public routes.
    expect(done()!["message"]).toContain("no app has public routes");
  });

  it("drops the MCP bypass everywhere once the Gateway's application has Managed OAuth", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const gateway = application(HOST)!;
    gateway["oauth_configuration"] = { enabled: true };

    await on();

    expect(overrides(application(HOST)!, HOST)).toEqual([]);
    expect(overrides(application(`*.${HOST}`)!, `*.${HOST}`)).toEqual([]);
    // Then nothing more to do.
    await on();
    expect(writes()).toEqual([]);
  });

  it("sets the team's global session only when asked", async () => {
    await seedPeople();
    await on({ team: "acme" });
    zt().organization!["session_duration"] = "24h";

    await on();
    expect(zt().organization!["session_duration"]).toBe("24h");

    await on({ teamSession: "168h" });
    expect(zt().organization!["session_duration"]).toBe("168h");
    expect(done()).toMatchObject({ data: { team: { sessionSet: "168h" } } });
  });
});

describe("access keeps the apps application in step with deploys", () => {
  it("lets an app's public routes through when it deploys, and takes them back when it is deleted", async () => {
    await seedPeople();
    await on({ team: "acme" });
    events = [];

    await deploy(appDir(TODO), TODO);
    expect(steps("app.access")).toEqual([expect.objectContaining({ status: "skip" })]);
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`]);

    events = [];
    const dir = appDir(CRM);
    await deploy(dir, CRM);
    expect(steps("app.access")).toEqual([
      expect.objectContaining({ status: "ok", data: expect.objectContaining({ appId: "crm", changed: true }) }),
    ]);
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`, `crm.${HOST}`]);
    expect(overrides(application(`*.${HOST}`)!, `crm.${HOST}`)).toEqual(["/mcp", "/mcp/*", "/t/*", "/t/e", "/health"]);

    // A redeploy with the same routes changes nothing at Access; neither does `access on`.
    events = [];
    account.cf.calls.length = 0;
    await deploy(dir, CRM);
    expect(steps("app.access")).toEqual([expect.objectContaining({ status: "skip" })]);
    expect(writes()).toEqual([]);
    await on();
    expect(writes()).toEqual([]);

    events = [];
    await removeApp({
      appId: "crm",
      out: out(),
      interactive: false,
      purge: false,
      createCf,
      reconcile: { ...seams, openRelease: () => openRelease(tarball), source: () => releaseSource(tarball) },
    });
    expect(error()).toBeUndefined();
    expect(steps("app.access")).toEqual([
      expect.objectContaining({ status: "ok", message: expect.stringContaining("no longer lets crm's"), data: expect.objectContaining({ removed: true }) }),
    ]);
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`]);
  });

  it("warns, and the deploy succeeds, when Access can't be updated", async () => {
    await seedPeople();
    await on({ team: "acme" });
    account.cf.override(["zero-trust", "access", "applications", "update"], {
      exitCode: 1,
      stderr: "\n┌ APIError\n│ [12060] access.api.error.invalid_request\n│ 400 Bad Request · HTTP /accounts/x/access/apps/y\n└\n",
    });
    events = [];

    await deploy(appDir(CRM), CRM);

    expect(error()).toBeUndefined();
    expect(warnings("ACCESS_SYNC_FAILED")[0]).toMatchObject({
      message: expect.stringContaining("need an Access login"),
      data: { appId: "crm", rerun: expect.stringContaining("access on") },
    });
    expect(warnings("ACCESS_SYNC_FAILED")[0]!["message"]).not.toContain("Run:");
    expect(steps("app.live").at(-1)).toMatchObject({ status: "ok" });
  });

  it("says, under a login that can't read Access, only that an app's public routes weren't checked, and only when it has some", async () => {
    await seedPeople();
    // No Access in front; a CI token without the Access permissions.
    account.cf.override(["zero-trust", "access", "applications", "list"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [10000] Authentication error\n└\n",
    });
    const remove = (appId: string) =>
      removeApp({
        appId,
        out: out(),
        interactive: false,
        purge: false,
        createCf,
        reconcile: { ...seams, openRelease: () => openRelease(tarball), source: () => releaseSource(tarball) },
      });

    await deploy(appDir(TODO), TODO);
    expect(error()).toBeUndefined();
    expect(warnings("ACCESS_NOT_CHECKED")).toEqual([]);
    expect(warnings("ACCESS_SYNC_FAILED")).toEqual([]);

    events = [];
    await deploy(appDir(CRM), CRM);
    expect(error()).toBeUndefined();
    expect(warnings("ACCESS_SYNC_FAILED")).toEqual([]);
    const warning = warnings("ACCESS_NOT_CHECKED")[0]!;
    expect(warning["message"]).toContain("can't read Cloudflare Access");
    expect(warning["message"]).toContain("If the Gateway is behind Access");
    expect(warning["message"]).not.toContain("need an Access login");
    expect(warning["data"]).toMatchObject({ appId: "crm", rerun: expect.stringContaining("access on") });

    // A delete knows the app's routes before its row goes: todo had none.
    events = [];
    await remove("todo");
    expect(error()).toBeUndefined();
    expect(warnings("ACCESS_NOT_CHECKED")).toEqual([]);
    events = [];
    await remove("crm");
    expect(error()).toBeUndefined();
    expect(warnings("ACCESS_NOT_CHECKED")[0]!["message"]).toContain("crm's host stays listed there");
  });
});

describe("access show", () => {
  it("says off, then on, and what is out of step", async () => {
    await seedPeople();
    await show();
    expect(done()).toMatchObject({ data: { on: false, team: null, fixes: [expect.stringContaining("access on")] } });

    await on({ team: "acme" });
    await show();
    expect(done()).toMatchObject({
      data: { on: true, applications: { gateway: { inSync: true }, apps: { inSync: true } }, linkPending: ["ben@acme.com", "jo@acme.com"] },
    });
    expect(done()!["data"]["fixes"]).toBeUndefined();

    // An app's public routes the apps application no longer lets through (changed by hand).
    await deploy(appDir(CRM), CRM);
    const apps = application(`*.${HOST}`)!;
    apps["destinations"] = (apps["destinations"] as Array<{ uri: string }>).filter((d) => d.uri === `*.${HOST}`);
    await show();
    expect(done()).toMatchObject({
      data: {
        applications: { apps: { inSync: false } },
        desired: { apps: [{ uri: `*.${HOST}` }, { uri: `crm.${HOST}`, public: ["/mcp", "/mcp/*", "/t/*", "/t/e", "/health"] }] },
        fixes: [expect.stringContaining("access on")],
      },
    });
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
    expect(zt().identityProviders.size).toBe(1);
    expect(done()).toMatchObject({ data: { removed: true, settings: [...ACCESS_SETTINGS], applications: { trimmed: [] } } });

    // Twice: nothing to do, no new version.
    await off();
    expect(done()).toMatchObject({ data: { removed: false } });
    expect(gatewayWorker().versions).toHaveLength(versions + 1);
  });

  it("only takes our hosts out of an application that also covers something else, and keeps them all with --keep-applications", async () => {
    await seedPeople();
    await on({ team: "acme" });
    const apps = application(`*.${HOST}`)!;
    (apps["destinations"] as unknown[]).push({ type: "public", uri: "wiki.example.org", overrides: [] });

    await off({ keepApplications: true });
    expect(applications()).toHaveLength(2);
    expect(gatewayWorker().secrets["CLOUDFLARE_ACCESS_AUD"]).toBeUndefined();

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
