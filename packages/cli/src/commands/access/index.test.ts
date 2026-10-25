/**
 * `everyapp access on|off|show` end to end, in a fake Cloudflare account
 * with a deployed gateway (as secret/index.test.ts): from nothing to a team,
 * both sign-in methods (a Cloudflare account, a PIN), a policy, two
 * applications and the Gateway's settings; a rerun that changes nothing;
 * a deploy and a delete keeping the apps application in step; what the
 * command leaves alone; and the way back.
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

/** An app whose manifest asks for /mcp on its own host, and has no public route. */
const INBOX: EveryAppCliManifest = {
  id: "inbox",
  resources: { d1: ["DB"] },
  mcp: { by: "gateway", why: "A connector per inbox, pinned in Claude." },
};

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
const provider = (type: string) => [...zt().identityProviders.values()].find((p) => p["type"] === type);
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

  it("creates the team, both sign-in methods, the policy, both applications and the settings, in one Worker version", async () => {
    await seedPeople();
    const versions = gatewayWorker().versions.length;

    await on({ team: "acme" });

    expect(error()).toBeUndefined();
    // The team, with the session the applications get.
    expect(zt().organization).toMatchObject({ auth_domain: "acme.cloudflareaccess.com", session_duration: "720h" });
    // The two ways to sign in: a Cloudflare account (this account's members only), and a code by email.
    expect([...zt().identityProviders.values()]).toHaveLength(2);
    const cloudflare = provider("cloudflare")!;
    const pin = provider("onetimepin")!;
    expect(cloudflare).toMatchObject({ name: "Cloudflare", config: { restrict_to_account_members: true } });
    expect(pin).toMatchObject({ name: "One-time PIN" });
    // Members who aren't deactivated, and the pending unexpired invitee.
    expect(policyEmails()).toEqual(["ben@acme.com", "jo@acme.com", "linked@acme.com", "sam@acme.com"]);
    expect(policy()).toMatchObject({ decision: "allow" });
    // The two applications: /health joins the Gateway's bypasses; the wildcard lets nothing through.
    const gateway = application(HOST)!;
    const apps = application(`*.${HOST}`)!;
    expect(gateway["id"]).not.toBe(apps["id"]);
    expect(overrides(gateway, HOST)).toEqual(["/mcp", "/mcp/*", "/oauth/token", "/oauth/register", "/.well-known/*", "/health"]);
    expect(uris(apps)).toEqual([`*.${HOST}`]);
    expect(overrides(apps, `*.${HOST}`)).toEqual([]);
    for (const app of [gateway, apps]) {
      expect(app).toMatchObject({
        type: "self_hosted",
        policies: [policy()!["id"]],
        session_duration: "720h",
        http_only_cookie_attribute: true,
        enable_binding_cookie: true,
        // Both allowed, so Access shows its chooser rather than redirecting to one.
        allowed_idps: [cloudflare["id"], pin["id"]],
        auto_redirect_to_identity: false,
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
        signInMethods: [
          { type: "cloudflare", restrictToAccountMembers: true, allowed: true },
          { type: "onetimepin", allowed: true },
        ],
        identityProviders: { oneTimePinAdded: true, cloudflareAdded: true },
        policy: { name: POLICY_NAME, created: true },
        applications: {
          gateway: { aud: gateway["aud"], outcome: "created", allowedIdps: [cloudflare["id"], pin["id"]] },
          apps: { aud: apps["aud"], outcome: "created" },
          combined: false,
        },
        settings: { names: [...ACCESS_SETTINGS], outcome: "set", reason: "missing" },
        // Who signs in with a password once: not the one who linked already, not the deactivated.
        signIn: { url: `https://${HOST}`, pending: ["ben@acme.com", "jo@acme.com"], first: "both" },
        next: [{ command: expect.stringContaining("secret set EMAIL_PASSWORD_SIGN_IN") }],
      },
    });
    expect(done()!["message"]).toContain("sign-in with a Cloudflare account or a one-time PIN");
    expect(done()!["message"]).toContain("ben@acme.com and jo@acme.com sign in once");
    expect(done()!["message"]).toContain("with their Cloudflare account if they are a member of this Cloudflare account");
    expect(done()!["message"]).toContain("MCP, the OAuth endpoints and /health let through");
    // The Cloudflare login (the fake's) is nobody on this Gateway: said, since Sign in with Cloudflare asserts it.
    expect(warnings("ACCESS_LOGIN_NOT_MEMBER")).toEqual([
      expect.objectContaining({ data: { email: expect.any(String) } }),
    ]);
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
    expect(done()).toMatchObject({ data: { team: { created: true }, identityProviders: { oneTimePinAdded: true, cloudflareAdded: true } } });
  });

  it("keeps a team's Cloudflare provider, adds the PIN beside it, and allows both on the applications", async () => {
    await seedPeople();
    // As Cloudflare's dashboard onboarding leaves a new team: its own provider, restricted to the account's members.
    zt().organization = { name: "acme", auth_domain: "acme.cloudflareaccess.com", session_duration: "24h", created_at: 0 };
    zt().identityProviders.set("idp-cf", { id: "idp-cf", type: "cloudflare", name: "Cloudflare account members", config: { restrict_to_account_members: true } });

    await on();

    expect(error()).toBeUndefined();
    expect([...zt().identityProviders.values()].map((p) => p["type"])).toEqual(["cloudflare", "onetimepin"]);
    expect(application(HOST)!["allowed_idps"]).toEqual(["idp-cf", provider("onetimepin")!["id"]]);
    expect(done()).toMatchObject({ data: { identityProviders: { oneTimePinAdded: true, cloudflareAdded: false }, signIn: { first: "both" } } });
    expect(warnings("ACCESS_IDP_ANY_CLOUDFLARE_ACCOUNT")).toEqual([]);
  });

  it("warns about a Cloudflare provider open to any Cloudflare account, on and show alike", async () => {
    await seedPeople();
    zt().organization = { name: "acme", auth_domain: "acme.cloudflareaccess.com", created_at: 0 };
    zt().identityProviders.set("idp-cf", { id: "idp-cf", type: "cloudflare", name: "Any Cloudflare user", config: { restrict_to_account_members: false } });

    await on();
    expect(warnings("ACCESS_IDP_ANY_CLOUDFLARE_ACCOUNT")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Any Cloudflare user (cloudflare) is open to any Cloudflare account, so left off the Every App applications"),
        data: { providers: [{ id: "idp-cf", type: "cloudflare", name: "Any Cloudflare user" }] },
      }),
    ]);
    // Left off: the PIN alone signs people in, redirected to, until the operator restricts the provider.
    expect(done()).toMatchObject({
      data: {
        signInMethods: [{ id: "idp-cf", restrictToAccountMembers: false, allowed: false }, { type: "onetimepin", allowed: true }],
        signIn: { first: "pin" },
      },
    });
    expect(application(HOST)).toMatchObject({ allowed_idps: [provider("onetimepin")!["id"]], auto_redirect_to_identity: true });

    await show();
    expect(warnings("ACCESS_IDP_ANY_CLOUDFLARE_ACCOUNT")).toHaveLength(1);
    expect(done()).toMatchObject({ data: { signIn: { cloudflare: true, pin: true, openToAnyCloudflareAccount: ["idp-cf"] } } });
  });

  it("adds Sign in with Cloudflare to applications made before it, taking nothing off them", async () => {
    await seedPeople();
    await on({ team: "acme" });
    // As `access on` left them before 2026-10-25: the PIN alone, redirected to; plus one the operator allowed by hand.
    const cloudflare = provider("cloudflare")!;
    zt().identityProviders.delete(cloudflare["id"] as string);
    zt().identityProviders.set("idp-okta", { id: "idp-okta", type: "okta", name: "Okta", config: {} });
    for (const app of applications()) {
      app["allowed_idps"] = app["id"] === application(HOST)!["id"] ? [provider("onetimepin")!["id"], "idp-okta"] : [provider("onetimepin")!["id"]];
      app["auto_redirect_to_identity"] = true;
    }

    await show();
    // The Gateway's names Okta beside the PIN and still redirects (two providers: it shouldn't); the apps'
    // names the PIN alone, redirected to, which is what `on` makes of a team without Sign in with Cloudflare.
    expect(done()).toMatchObject({
      data: {
        signIn: { cloudflare: false, pin: true },
        applications: { gateway: { signInInSync: false }, apps: { signInInSync: true } },
        fixes: [expect.stringContaining("access on")],
      },
    });

    await on();

    expect(error()).toBeUndefined();
    // Sign in with Cloudflare joins both applications; the operator's Okta
    // stays where they allowed it (the Gateway's) and is added nowhere: the
    // team is account-wide, and `on` allows only the two methods it vouches for.
    const added = provider("cloudflare")!;
    expect(application(HOST)).toMatchObject({
      allowed_idps: [provider("onetimepin")!["id"], "idp-okta", added["id"]],
      auto_redirect_to_identity: false,
    });
    expect(application(`*.${HOST}`)).toMatchObject({
      allowed_idps: [provider("onetimepin")!["id"], added["id"]],
      auto_redirect_to_identity: false,
    });
    expect(done()).toMatchObject({
      data: {
        identityProviders: { cloudflareAdded: true, oneTimePinAdded: false },
        signInMethods: [
          { type: "onetimepin", allowed: true },
          { id: "idp-okta", type: "okta", allowed: false },
          { id: added["id"], type: "cloudflare", allowed: true },
        ],
        applications: {
          gateway: { outcome: "updated", signInAdded: [added["id"]] },
          apps: { outcome: "updated", signInAdded: [added["id"]] },
        },
      },
    });
    expect(done()!["message"]).toContain("sign-in methods added");
    expect(done()!["message"]).toContain("sign-in with a Cloudflare account or a one-time PIN");
    expect(done()!["message"]).toContain("Okta (okta) is on the team but not allowed on the Every App applications");

    // `show` agrees: in sync now, Okta listed as the team's, not compared.
    await show();
    expect(done()).toMatchObject({
      data: {
        signIn: { methods: expect.arrayContaining([expect.objectContaining({ id: "idp-okta", allowed: false })]) },
        applications: { gateway: { signInInSync: true }, apps: { signInInSync: true } },
      },
    });
    expect(done()!["data"]).not.toHaveProperty("fixes");

    // Then nothing more to do, and show agrees.
    await on();
    expect(writes()).toEqual([]);
    await show();
    expect(done()).toMatchObject({ data: { applications: { gateway: { signInInSync: true }, apps: { signInInSync: true } } } });
    expect(done()!["data"]["fixes"]).toBeUndefined();
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
    apps["enable_binding_cookie"] = false;

    await on();

    expect(error()).toBeUndefined();
    expect(uris(application(`*.${HOST}`)!)).toEqual(["wiki.example.org", `*.${HOST}`]);
    expect(overrides(application(`*.${HOST}`)!, `*.${HOST}`)).toEqual([]);
    expect(warnings("ACCESS_FOREIGN_DESTINATION")[0]).toMatchObject({ data: { uris: ["wiki.example.org"] } });
    // The application with policies of its own is left alone, paths and all.
    expect(application(HOST)!["policies"]).toEqual(["inline-1"]);
    expect(overrides(application(HOST)!, HOST)).toEqual([]);
    expect(warnings("ACCESS_INLINE_POLICIES")).toHaveLength(1);
    expect(done()).toMatchObject({ data: { applications: { gateway: { outcome: "skipped" }, apps: { outcome: "updated" } } } });
    // The destination for something else isn't an app with public routes.
    expect(done()!["message"]).toContain("no app has public routes or /mcp");
  });

  it("drops the MCP bypass everywhere once the Gateway's application has Managed OAuth, keeping /health", async () => {
    await seedPeople();
    await deploy(appDir(INBOX), INBOX);
    await on({ team: "acme" });
    expect(overrides(application(`*.${HOST}`)!, `inbox.${HOST}`)).toEqual(["/mcp", "/mcp/*"]);
    const gateway = application(HOST)!;
    gateway["oauth_configuration"] = { enabled: true };

    await on();

    expect(overrides(application(HOST)!, HOST)).toEqual(["/health"]);
    expect(overrides(application(`*.${HOST}`)!, `*.${HOST}`)).toEqual([]);
    // An app that asked for /mcp alone loses its destination: nothing would be let through on it.
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`]);
    expect(done()!["message"]).toContain("no app has public routes or /mcp");
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

// Each of these deploys (and deletes) through the fake Gateway more than once: room beyond the default 5 s.
describe("access keeps the apps application in step with deploys", { timeout: 30_000 }, () => {
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
      expect.objectContaining({ status: "ok", message: "Cloudflare Access lets crm's public routes through.", data: expect.objectContaining({ appId: "crm", changed: true }) }),
    ]);
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`, `crm.${HOST}`]);
    // Its routes alone: the manifest doesn't ask for /mcp on its host.
    expect(overrides(application(`*.${HOST}`)!, `crm.${HOST}`)).toEqual(["/t/*", "/t/e", "/health"]);

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

  it("lets an app's /mcp through when its manifest opts in, with no public route", async () => {
    await seedPeople();
    await on({ team: "acme" });
    events = [];

    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    expect(steps("app.access")).toEqual([
      expect.objectContaining({ status: "ok", message: "Cloudflare Access lets inbox's /mcp through." }),
    ]);
    expect(overrides(application(`*.${HOST}`)!, `inbox.${HOST}`)).toEqual(["/mcp", "/mcp/*"]);

    // `access on` agrees; `show` lists it as desired.
    events = [];
    account.cf.calls.length = 0;
    await on();
    expect(writes()).toEqual([]);
    // No app has public routes: only the /mcp count is said.
    expect(done()!["message"]).toContain("/mcp on 1 app host let through");
    expect(done()!["message"]).not.toContain("public routes of");
    await show();
    expect(done()).toMatchObject({ data: { desired: { apps: [{ uri: `*.${HOST}`, public: [] }, { uri: `inbox.${HOST}`, public: ["/mcp", "/mcp/*"] }] } } });


    // A deploy without the opt-in takes it back.
    events = [];
    const plain: EveryAppCliManifest = { id: "inbox", resources: { d1: ["DB"] } };
    account.apps.set(dir, plain);
    fs.writeFileSync(path.join(dir, "everyapp.config.ts"), `export default ${JSON.stringify(plain, null, 2)} as const;\n`);
    await deploy(dir, plain);
    expect(steps("app.access")).toEqual([expect.objectContaining({ status: "ok", data: expect.objectContaining({ changed: true }) })]);
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`]);

    // Opted in again, then deleted: the delete takes /mcp back, in those words.
    account.apps.set(dir, INBOX);
    fs.writeFileSync(path.join(dir, "everyapp.config.ts"), `export default ${JSON.stringify(INBOX, null, 2)} as const;\n`);
    await deploy(dir, INBOX);
    expect(overrides(application(`*.${HOST}`)!, `inbox.${HOST}`)).toEqual(["/mcp", "/mcp/*"]);
    events = [];
    await removeApp({
      appId: "inbox",
      out: out(),
      interactive: false,
      purge: false,
      createCf,
      reconcile: { ...seams, openRelease: () => openRelease(tarball), source: () => releaseSource(tarball) },
    });
    expect(error()).toBeUndefined();
    expect(steps("app.access")).toEqual([
      expect.objectContaining({ status: "ok", message: "Cloudflare Access no longer lets inbox's /mcp through.", data: expect.objectContaining({ removed: true }) }),
    ]);
    expect(uris(application(`*.${HOST}`)!)).toEqual([`*.${HOST}`]);
  });

  it("says, under a login that can't read Access, that an opted-in /mcp wasn't checked", async () => {
    await seedPeople();
    account.cf.override(["zero-trust", "access", "applications", "list"], {
      exitCode: 1,
      stderr: "┌ APIError\n│ [10000] Authentication error\n└\n",
    });

    await deploy(appDir(INBOX), INBOX);

    expect(error()).toBeUndefined();
    const warning = warnings("ACCESS_NOT_CHECKED")[0]!;
    expect(warning["message"]).toContain("inbox's /mcp need a login there");
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
        signIn: { cloudflare: true, pin: true, openToAnyCloudflareAccount: [] },
        applications: { apps: { inSync: false, signInInSync: true } },
        desired: { apps: [{ uri: `*.${HOST}`, public: [] }, { uri: `crm.${HOST}`, public: ["/t/*", "/t/e", "/health"] }] },
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
    expect(zt().identityProviders.size).toBe(2);
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
