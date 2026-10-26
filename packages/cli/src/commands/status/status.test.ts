/**
 * `everyapp status`, all from the gateway's D1 and cf in a fake
 * account: the install row, the registry, the owner, certificates, running
 * deploys, each app's settings against the Workers' secret names, and what
 * to run when they disagree. Nothing goes to the gateway.
 */
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAccessSettingsRecord } from "@/lib/access/record";
import { ACCESS_SETTINGS } from "@/lib/access/settings";
import { applyEmailRoutes, planEmailRoutes } from "@/lib/app/emailRoutes";
import { recordOwnedResource } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { discoverGateway } from "@/lib/gateway/discover";
import { LeasePurpose } from "@/lib/gateway/lease";
import { holdLease } from "@/test/holdLease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { markDeployed, readApp, register, writeAppEmail } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import { createHumanSink, createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import type { CandidateRelease } from "@/lib/gateway/release";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { existingGateway } from "@/lib/gateway/connect";
import { turnAccessOn } from "../access";
import { reportStatus } from "./index";

let account: FakeCloudflare;
let tarball: string;
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
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  checkout = () => releaseSource(tarball);
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
/** An app that receives mail: its Worker exports email(). */
const INBOX = { id: "inbox", email: { inbound: true } };

async function deployed(
  appSlug: string,
  { bind = true, manifest = { id: appSlug } }: { bind?: boolean; manifest?: Record<string, unknown> } = {},
) {
  const { plan } = await register(db(), {
    appSlug,
    name: appSlug,
    description: appSlug,
    manifest,
    appBaseDomain: "example.com",
    deployer: { actor: "dev@example.com", email: "dev@example.com" },
    organizationName: "Acme",
  });
  await markDeployed(db(), plan.app.id, {
    versionId: `${appSlug}-v1`,
    manifest,
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
      databaseId: (await found()).databaseId,
      openRelease: () => openRelease(tarball),
      interactive: false,
      cliVersion: "0.3.0",
      ...quick,
    });
  }
  return plan.app;
}

/** The Gateway discovery finds in the fake account. */
async function found(cloudflare = account) {
  const { gateway } = await discoverGateway({
    whoami: { authenticated: true, accounts: [{ id: ACCOUNT_ID, name: "Acme" }] },
    createCf: () => cloudflare.cf,
    interactive: false,
  });
  return gateway!;
}

/** This checkout's Gateway, as status reads it; a test can change it. */
let checkout: (() => Promise<CandidateRelease>) | null;

async function status() {
  events = [];
  await reportStatus({ gateway: await found(), out: out(), checkout });
  return events.at(-1)!;
}

/** What a person sees: the report on stdout, colors stripped. */
async function shown(cloudflare = account) {
  let text = "";
  await reportStatus({
    gateway: await found(cloudflare),
    out: createHumanSink({ write: (chunk) => (text += chunk), writeProblem: (chunk) => (text += chunk) }),
    checkout,
  });
  return stripVTControlCharacters(text);
}

const fixCodes = (done: Record<string, any>) =>
  (done["data"]["fixes"] as Array<{ code: string }>).map((fix) => fix.code);
const nextCodes = (done: Record<string, any>) =>
  (done["data"]["next"] as Array<{ code: string }>).map((step) => step.code);

describe("everyapp status", () => {
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
    // No owner yet: the one thing to do (and no `note`, since none was said).
    expect(done["data"]["fixes"]).toEqual([
      {
        code: "NO_OWNER",
        severity: "warning",
        message:
          "No owner yet, so nobody can sign in\nApps still deploy. Setup prints a one-time link that creates the owner account.",
        run: "pnpm everyapp setup",
      },
    ]);
    expect(done["message"]).toBe("Gateway https://example.com: 1 app live, 1 problem to fix");
    const report = await shown();
    expect(report).toMatch(/\ntodo +✓ live +https:\/\/todo\.example\.com +dev@example\.com\n/);
    expect(report).toMatch(/\nOwner +none yet\n/);
    expect(report).toContain(
      [
        "! No owner yet, so nobody can sign in",
        "  Apps still deploy. Setup prints a one-time link that creates the owner account.",
        "  Run: pnpm everyapp setup",
      ].join("\n"),
    );
  });

  it("shows an API token's deploys as such, and an empty Gateway as one with an app to create", async () => {
    const empty = await shown();
    expect(empty).toContain("\nNo apps yet.\n");
    // Unclaimed: `access on` waits for the owner (it refuses with nobody to let in).
    expect(empty).toContain("\nNext:\n  pnpm everyapp create ../my-app  start your first app\n");
    expect(empty).not.toContain("pnpm everyapp access on");

    await deployed("todo");
    account.database("every-app-gateway").sqlite.exec(
      `UPDATE apps SET deployed_by_actor = 'api-token:${ACCOUNT_ID}'`,
    );
    expect(await shown()).toMatch(/\ntodo +○ live on first visit +https:\/\/todo\.example\.com +API token\n/);
  });

  it("lists what each app's deployed manifest opens without a sign-in: its routes, and /mcp where it asks for it", async () => {
    await deployed("hooks", {
      manifest: {
        id: "hooks",
        public: [
          { path: "/hooks/*" },
          { path: "/collect", methods: ["POST"] },
          { path: "/uploads/**", methods: ["GET", "HEAD"] },
          { path: "/t/e", methods: ["POST"] },
        ],
      },
    });
    await deployed("inbox", {
      manifest: { id: "inbox", mcp: { by: "gateway", why: "A connector per inbox, pinned in Claude." } },
    });
    await deployed("todo");

    const done = await status();
    expect(done["data"]["apps"]).toEqual([
      expect.objectContaining({
        id: "hooks",
        publicRoutes: [
          { path: "/hooks/*", methods: ["GET"] },
          { path: "/collect", methods: ["POST"] },
          { path: "/uploads/**", methods: ["GET", "HEAD"] },
          { path: "/t/e", methods: ["POST"] },
        ],
        mcp: null,
      }),
      expect.objectContaining({
        id: "inbox",
        publicRoutes: [],
        mcp: { by: "gateway", why: "A connector per inbox, pinned in Claude." },
      }),
      expect.objectContaining({ id: "todo", publicRoutes: [], mcp: null }),
    ]);
    const report = await shown();
    expect(report).toMatch(/\nAPP +STATUS +URL +DEPLOYED BY +PUBLIC\n/);
    // The first three routes, then how many more.
    expect(report).toMatch(
      /\nhooks +○ live on first visit +https:\/\/hooks\.example\.com +dev@example\.com +GET \/hooks\/\*, POST \/collect, GET\/HEAD \/uploads\/\*\* \+1 more\n/,
    );
    expect(report).toMatch(
      /\ninbox +○ live on first visit +https:\/\/inbox\.example\.com +dev@example\.com +MCP \/mcp \(gateway\)\n/,
    );
    // An app that opens nothing: an empty cell, and no blanks after its row.
    expect(report).toMatch(/\ntodo +○ live on first visit +https:\/\/todo\.example\.com +dev@example\.com\n/);
  });

  it("lists the mail each app's deploys route to it, and what to run when a route stops delivering", async () => {
    const inbox = await deployed("inbox", { manifest: INBOX });
    await deployed("todo");
    account.emailRoutingOf("zone-1").enabled = true;
    await writeAppEmail(
      db(),
      "inbox",
      { senders: [], inbound: ["*@example.com", "support@example.com"] },
      { actor: "dev@example.com", email: "dev@example.com" },
    );
    const plan = await planEmailRoutes({
      cf: account.cf,
      gatewayDb: db(),
      accountId: ACCOUNT_ID,
      workerName: inbox.workerName!,
      addresses: ["*@example.com", "support@example.com"],
      interactive: false,
    });
    await applyEmailRoutes({ cf: account.cf, gatewayDb: db(), plan: plan! });

    const done = await status();
    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({
        id: "inbox",
        email: {
          senders: [],
          inbound: ["*@example.com", "support@example.com"],
          routed: ["*@example.com", "support@example.com"],
          declaresInbound: true,
        },
      }),
    );
    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({
        id: "todo",
        email: { senders: [], inbound: [], routed: [], declaresInbound: false },
      }),
    );
    // One address a line; todo, with no mail, has no row.
    expect(await shown()).toContain(
      [
        "EMAIL  SENDS AS              RECEIVES",
        "inbox  the Gateway's sender  *@example.com",
        "                             support@example.com",
      ].join("\n"),
    );
    expect(fixCodes(done)).not.toContain("EMAIL_ROUTE_MISSING");
    expect(fixCodes(done)).not.toContain("EMAIL_ROUTE_PENDING");

    // Someone deleted the rule by hand.
    const [rule] = account.emailRulesFor("zone-1", "support@example.com");
    account.emailRoutingOf("zone-1").rules.delete(rule!.id);
    expect((await status())["data"]["fixes"]).toContainEqual({
      code: "EMAIL_ROUTE_MISSING",
      severity: "warning",
      message: "inbox doesn't get mail at support@example.com\nIts Email Routing rule is gone.",
      run: "pnpm everyapp deploy from inbox's directory",
    });
    expect(await shown()).toContain("support@example.com ! not delivered");

    // cf can't read the rules: a problem in the report, which stands.
    account.cf.override(["email-routing"], { exitCode: 1, stderr: "┌ Error\n│ boom\n└\n" });
    const unknown = await status();
    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
    expect(fixCodes(unknown)).toContain("EMAIL_ROUTES_UNKNOWN");
    expect(fixCodes(unknown)).not.toContain("EMAIL_ROUTE_MISSING");
    expect(unknown["data"]["apps"]).toHaveLength(2);
    expect(await shown()).toContain("! Couldn't check the apps' Email Routing rules\n  Cloudflare said: boom.");
  });

  it("names an address set but not routed yet", async () => {
    const inbox = await deployed("inbox", { manifest: INBOX });
    account.emailRoutingOf("zone-1").enabled = true;
    const deployer = { actor: "dev@example.com", email: "dev@example.com" };
    await writeAppEmail(db(), "inbox", { senders: ["*@example.com"], inbound: ["*@example.com"] }, deployer);
    const plan = await planEmailRoutes({
      cf: account.cf,
      gatewayDb: db(),
      accountId: ACCOUNT_ID,
      workerName: inbox.workerName!,
      addresses: ["*@example.com"],
      interactive: false,
    });
    await applyEmailRoutes({ cf: account.cf, gatewayDb: db(), plan: plan! });
    // A longer list, stored (as `everyapp email set` does first) but not routed yet.
    await writeAppEmail(
      db(),
      "inbox",
      { senders: ["*@example.com"], inbound: ["*@example.com", "support@example.com"] },
      deployer,
    );

    const done = await status();

    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({
        id: "inbox",
        email: {
          senders: ["*@example.com"],
          inbound: ["*@example.com", "support@example.com"],
          routed: ["*@example.com"],
          declaresInbound: true,
        },
      }),
    );
    expect(await shown()).toContain(
      [
        "inbox  *@example.com  *@example.com",
        "                      support@example.com ! not routed yet",
      ].join("\n"),
    );
    expect(done["data"]["fixes"]).toContainEqual({
      code: "EMAIL_ROUTE_PENDING",
      severity: "warning",
      message: "inbox doesn't get mail at support@example.com yet",
      run: "pnpm everyapp deploy from inbox's directory",
    });

    // The other way round too: a route the list no longer names. One
    // deploy fixes both, so one problem says both.
    await writeAppEmail(db(), "inbox", { senders: [], inbound: ["support@example.com"] }, deployer);
    const both = await status();
    expect(both["data"]["fixes"]).toContainEqual(
      expect.objectContaining({
        code: "EMAIL_ROUTE_PENDING",
        severity: "warning",
        message:
          "inbox's mail routes don't match its addresses\nsupport@example.com isn't routed yet; *@example.com is still routed, though no longer listed.",
      }),
    );
    expect(fixCodes(both).filter((code) => code.startsWith("EMAIL"))).toHaveLength(1);
  });

  it("sends an app whose deployed manifest dropped the declaration to email unset, not to a deploy that changes nothing", async () => {
    // As a deploy without `email: { inbound: true }` leaves it: routes removed, the list kept.
    await deployed("inbox");
    await writeAppEmail(
      db(),
      "inbox",
      { senders: [], inbound: ["*@example.com", "support@example.com"] },
      { actor: "dev@example.com", email: "dev@example.com" },
    );

    const done = await status();

    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({
        id: "inbox",
        email: {
          senders: [],
          inbound: ["*@example.com", "support@example.com"],
          routed: [],
          declaresInbound: false,
        },
      }),
    );
    expect(done["data"]["fixes"]).toContainEqual({
      code: "EMAIL_INBOUND_UNDECLARED",
      severity: "warning",
      message:
        "inbox has inbound addresses, but its config doesn't turn inbound mail on\ninbox was deployed without email: { inbound: true }, so nothing routes *@example.com and support@example.com.",
      run: null,
      fix: "declare it in everyapp.config.ts and run pnpm everyapp deploy, or drop the addresses: pnpm everyapp email unset inbound",
    });
    expect(fixCodes(done)).not.toContain("EMAIL_ROUTE_PENDING");
    const report = await shown();
    expect(report).toContain("inbox  the Gateway's sender  ! *@example.com (inbound off)");
    expect(report).toContain(
      [
        "  Fix: declare it in everyapp.config.ts and run pnpm everyapp deploy, or drop the addresses: pnpm everyapp email unset inbound",
        "  Run either from inbox's directory.",
      ].join("\n"),
    );
  });

  it("lists each app's settings, says which app needs setup and what to run, and records the Workers' secret names", async () => {
    // Two required settings unset (one the Gateway's, one the app's), an optional one.
    const crm = await deployed("crm", {
      manifest: {
        id: "crm",
        providers: [{ id: "openrouter", why: "Drafts replies." }],
        capabilities: { context: { access: "read", optional: true } },
        secrets: ["TOKEN_ENCRYPTION_KEY"],
      },
    });
    // Nothing to set: no rows, no setup.
    await deployed("todo");
    await new GatewayWorker(account).fetch("https://crm.example.com/");

    const done = await status();

    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({
        id: "crm",
        status: "active",
        setup: expect.objectContaining({
          ready: false,
          unmet: [
            expect.objectContaining({ id: "openrouter", set: false }),
            expect.objectContaining({ id: "TOKEN_ENCRYPTION_KEY", set: false }),
          ],
          command: { command: "pnpm everyapp configure crm" },
        }),
      }),
    );
    expect(done["data"]["apps"]).toContainEqual(expect.objectContaining({ id: "todo", setup: null }));
    expect(done["data"]["fixes"]).toContainEqual({
      code: "APP_NEEDS_SETUP",
      severity: "warning",
      message:
        "crm needs setup\nOpenRouter: Drafts replies.\nAn API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.\nGet it at https://openrouter.ai/settings/keys\nGuide: .claude/skills/everyapp/setup/openrouter.md\nTOKEN_ENCRYPTION_KEY",
      run: "pnpm everyapp configure crm",
    });
    // todo goes live on its first visit; the setup problem counts with the missing owner.
    expect(done["message"]).toBe("Gateway https://example.com: 1 app live, 2 problems to fix");
    // The Worker's names are on record now (none yet).
    expect((await readApp(db(), "crm")).secretNames).toEqual([]);
    const report = await shown();
    expect(report).toMatch(/\ncrm +! needs setup +https:\/\/crm\.example\.com/);
    expect(report).toContain(
      [
        "APP  SETTING               WHERE    STATUS",
        "crm  OPENROUTER_API_KEY    Gateway  ! not set",
        "crm  CONTEXT_API_KEY       Gateway  not set (optional)",
        "crm  TOKEN_ENCRYPTION_KEY  crm      ! not set",
      ].join("\n"),
    );
    expect(report).toContain(
      [
        "! crm needs setup",
        "  OpenRouter: Drafts replies.",
        // What the provider's entry says the key is (its hint).
        "  An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.",
        "  Get it at https://openrouter.ai/settings/keys",
        "  Guide: .claude/skills/everyapp/setup/openrouter.md",
        "  TOKEN_ENCRYPTION_KEY",
        "  Run: pnpm everyapp configure crm",
      ].join("\n"),
    );

    // Set outside everyapp: the next status sees it, records it, and the app is live.
    account.workers.get("every-app-gateway")!.secrets["OPENROUTER_API_KEY"] = "sk-or";
    account.workers.get(crm.workerName!)!.secrets["TOKEN_ENCRYPTION_KEY"] = "tek";
    const ready = await status();
    expect(fixCodes(ready)).not.toContain("APP_NEEDS_SETUP");
    expect(ready["data"]["apps"]).toContainEqual(
      expect.objectContaining({ id: "crm", setup: expect.objectContaining({ ready: true, command: null }) }),
    );
    expect((await readApp(db(), "crm")).secretNames).toEqual(["TOKEN_ENCRYPTION_KEY"]);
    const live = await shown();
    expect(live).toMatch(/\ncrm +✓ live +https:\/\/crm\.example\.com/);
    expect(live).toContain("crm  TOKEN_ENCRYPTION_KEY  crm      ✓ set");
  });

  it("says once when the Workers' secrets can't be listed, blocks on nothing, and records nothing", async () => {
    const crm = await deployed("crm", {
      manifest: { id: "crm", providers: ["openrouter"], secrets: ["TOKEN_ENCRYPTION_KEY"] },
    });
    account.workers.get(crm.workerName!)!.secrets["TOKEN_ENCRYPTION_KEY"] = "tek";
    account.cf.override(["workers", "secrets", "list"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });

    const done = await status();

    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
    expect(fixCodes(done)).toContain("SETTINGS_UNKNOWN");
    expect(fixCodes(done)).not.toContain("APP_NEEDS_SETUP");
    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({
        id: "crm",
        setup: expect.objectContaining({
          ready: true,
          settings: [
            expect.objectContaining({ id: "openrouter", set: null }),
            expect.objectContaining({ id: "TOKEN_ENCRYPTION_KEY", set: null }),
          ],
        }),
      }),
    );
    expect((await readApp(db(), "crm")).secretNames).toBeNull();
    const report = await shown();
    expect(report).toContain("crm  OPENROUTER_API_KEY    Gateway  ! couldn't check");
    expect(report).toContain("crm  TOKEN_ENCRYPTION_KEY  crm      ! not recorded");
    expect(report).toContain(
      "! Couldn't list the Workers' secrets\n  Cloudflare said: Authentication error [code: 10000]. Whether the apps' settings are set isn't known.",
    );
    expect(report.match(/Couldn't list the Workers' secrets/g)).toHaveLength(1);
  });

  it("evaluates nothing for an app that was never uploaded, whose Worker is gone, or on the dispatch tier", async () => {
    await register(db(), {
      appSlug: "notes",
      name: "notes",
      description: "notes",
      manifest: { id: "notes", secrets: ["MAIN_SECRET"] },
      appBaseDomain: "example.com",
      deployer: { actor: "dev@example.com", email: "dev@example.com" },
      organizationName: "Acme",
    });
    await deployed("chef", { manifest: { id: "chef", providers: ["openai"] } });
    account.workers.delete("every-acme-chef");
    // A third-party app on the hosted Gateway's dispatch tier: the platform doesn't gate its settings.
    await deployed("shop", { manifest: { id: "shop", providers: ["openai"] } });
    await db().run([{ sql: "UPDATE apps SET tier = 'dispatch' WHERE app_slug = ?", params: ["shop"] }]);

    const done = await status();

    expect(done["data"]["apps"]).toContainEqual(expect.objectContaining({ id: "notes", setup: null }));
    expect(done["data"]["apps"]).toContainEqual(expect.objectContaining({ id: "chef", setup: null }));
    expect(done["data"]["apps"]).toContainEqual(expect.objectContaining({ id: "shop", setup: null }));
    expect(fixCodes(done)).not.toContain("APP_NEEDS_SETUP");
    expect(fixCodes(done)).not.toContain("SETTINGS_UNKNOWN");
    expect(await shown()).not.toContain("SETTING");
  });

  it("names the Hyperdrive origin a first deploy stopped for, and where it goes, until the config exists", async () => {
    const registerPending = (appSlug: string, hyperdrive: Array<{ name: string }>) =>
      register(db(), {
        appSlug,
        name: appSlug,
        description: appSlug,
        manifest: { id: appSlug, resources: { hyperdrive }, database: { provider: "postgres" } },
        appBaseDomain: "example.com",
        deployer: { actor: "dev@example.com", email: "dev@example.com" },
        organizationName: "Acme",
      });
    // One config: POSTGRES_DATABASE_URL serves it. Two: each its own variable.
    await registerPending("seo", [{ name: "HYPERDRIVE" }]);
    await registerPending("crawler", [{ name: "PAGES" }, { name: "STATS_DB" }]);
    // crawler's PAGES config was created before the deploy stopped elsewhere.
    await recordOwnedResource(db(), "every-acme-crawler", {
      kind: "hyperdrive",
      binding: "PAGES",
      name: "every-acme-crawler--pages",
      resourceId: "hd-pages",
    });

    const done = await status();

    const fixes = done["data"]["fixes"] as Array<{ code: string; message: string }>;
    expect(fixes.find((fix) => fix.message.startsWith("seo "))).toEqual(
      expect.objectContaining({
        code: "APP_NOT_UPLOADED",
        message: [
          "seo was registered, but none of its deploys finished",
          "HYPERDRIVE needs the database its Hyperdrive config connects to: POSTGRES_DATABASE_URL (or HYPERDRIVE_ORIGIN_URL) in .everyapp/secrets.env, on the machine that deploys it.",
        ].join("\n"),
      }),
    );
    expect(fixes.find((fix) => fix.message.startsWith("crawler "))!.message).toBe(
      [
        "crawler was registered, but none of its deploys finished",
        "STATS_DB needs the database its Hyperdrive config connects to: STATS_DB_ORIGIN_URL in .everyapp/secrets.env, on the machine that deploys it.",
      ].join("\n"),
    );
    expect(await shown()).toContain(
      [
        "! seo was registered, but none of its deploys finished",
        "  HYPERDRIVE needs the database its Hyperdrive config connects to: POSTGRES_DATABASE_URL (or HYPERDRIVE_ORIGIN_URL) in .everyapp/secrets.env, on the machine that deploys it.",
      ].join("\n"),
    );

    // Once the config exists, the deploy needs no origin to finish.
    await recordOwnedResource(db(), "every-acme-seo", {
      kind: "hyperdrive",
      binding: "HYPERDRIVE",
      name: "every-acme-seo--hyperdrive",
      resourceId: "hd-seo",
    });
    const later = (await status())["data"]["fixes"] as Array<{ message: string }>;
    expect(later.find((fix) => fix.message.startsWith("seo "))!.message).toBe(
      "seo was registered, but none of its deploys finished",
    );
  });

  it("prints the deployment mode the install recorded", async () => {
    const done = await status();
    expect(done["data"]["mode"]).toBe("self_hosted");
    expect(await shown()).toContain("https://example.com · self-hosted");
  });

  it("says when cf can't list the certificates, in the report", async () => {
    account.cf.override(["ssl", "certificate-packs", "list"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });

    const done = await status();

    expect(events.filter((event) => event["type"] === "warning")).toEqual([]);
    expect(done["data"]).toMatchObject({ tls: null, certificates: null });
    expect(fixCodes(done)).toContain("CERTIFICATES_UNKNOWN");
    const report = await shown();
    expect(report).toMatch(/\nTLS +! couldn't check\n/);
    expect(report).toContain("! Couldn't list example.com's certificates\n  Cloudflare said: ");
  });

  it("puts the problems one command fixes in one block", async () => {
    // No owner, and an app the live Gateway doesn't bind: setup does both.
    await deployed("board", { bind: false });

    const report = await shown();

    expect(report).toContain(
      [
        "! The live Gateway doesn't serve board",
        "  board is uploaded, but the live Gateway doesn't bind it.",
        "  No owner yet, so nobody can sign in.",
        "  Run: pnpm everyapp setup",
      ].join("\n"),
    );
    expect(report.match(/Run: pnpm everyapp setup/g)).toHaveLength(1);
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
    await holdLease(db(), "app:every-acme-todo", LeasePurpose.AppDeploy, "todo");
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
      expect.objectContaining({ code: "BINDINGS_DIFFER", run: "pnpm everyapp setup" }),
    );
    expect(done["data"]["apps"]).toContainEqual(
      expect.objectContaining({ id: "board", status: "binding", bound: false }),
    );
    const report = await shown();
    expect(report).toMatch(/\nDeploys +A deploy of todo from .+, started .+ ago\n/);
    expect(report).toMatch(/\nboard +! not bound +https:\/\/board\.example\.com/);
    expect(report).toMatch(/\nchef +✗ Worker missing +https:\/\/chef\.example\.com/);
    expect(report).toMatch(/\nnotes +! never deployed +https:\/\/notes\.example\.com/);
    expect(report).toMatch(/\ntodo +○ live on first visit · deploying +https:\/\/todo\.example\.com/);
    expect(report).toContain(
      "! The live Gateway doesn't serve board\n  board is uploaded, but the live Gateway doesn't bind it.\n  Run: pnpm everyapp setup",
    );
    expect(report).toContain(
      "✗ chef's Worker no longer exists\n  Run: pnpm everyapp deploy from chef's directory, or pnpm everyapp delete chef",
    );
    // A running deploy shows in its rows, not as something to do.
    expect(report).not.toContain("is running");

    // The gateway changed outside everyapp: that comes first.
    account.workers.get("every-app-gateway")!.versions.push("dashboard-1");
    expect(fixCodes(await status())).toContain("GATEWAY_CHANGED");
    const changed = await shown();
    expect(changed).toMatch(/\nRelease +0\.2\.0 · changed outside everyapp\n/);
    expect(changed).toContain(
      "! The Gateway Worker was changed outside everyapp\n  It serves a version from the dashboard or API, not the one setup uploaded.\n  Run: pnpm everyapp setup  redeploys 0.2.0, asking first",
    );
  });

  it("names where the live release came from, for a CLI with no checkout", async () => {
    // Installed from the published release: the install row keeps the tag and the commit.
    account.database("every-app-gateway").sqlite.exec(
      `UPDATE _everyapp_install SET release_origin = '{"kind":"github","repo":"every-app/every-app","tag":"gateway-v0.3.0-rc.4"}', release_git_sha = '302315f511eb18f26c34e7db2d07ecc305d903b1'`,
    );
    checkout = null;
    const done = await status();
    expect(done["data"]["release"]).toMatchObject({
      origin: { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0-rc.4" },
      gitSha: "302315f511eb18f26c34e7db2d07ecc305d903b1",
    });
    expect(done["data"]["checkout"]).toBeNull();
    expect(await shown()).toMatch(
      /\nRelease +0\.2\.0 · from every-app\/every-app release gateway-v0\.3\.0-rc\.4\n/,
    );

    // Built from a checkout: its commit.
    account.database("every-app-gateway").sqlite.exec(
      `UPDATE _everyapp_install SET release_origin = '{"kind":"checkout"}', release_git_sha = '302315f511eb18f26c34e7db2d07ecc305d903b1-dirty'`,
    );
    expect(await shown()).toMatch(
      /\nRelease +0\.2\.0 · from a checkout at 302315f5 with uncommitted changes\n/,
    );
  });

  it("says whether the live Gateway is the one this checkout builds, and what to run when not", async () => {
    // The live release was built from sources that hash to "tree-1".
    account.database("every-app-gateway").sqlite.exec(
      "UPDATE _everyapp_install SET source_tree_sha256 = 'tree-1'",
    );
    const at = async (treeSha256: string | null, committedAt?: number, version?: string) => {
      const source = await releaseSource(tarball);
      checkout = async () => ({
        ...source,
        version: version ?? source.version,
        treeSha256,
        order: { ...source.order, committedAt: committedAt ?? source.order.committedAt },
      });
      return status();
    };
    const checkoutFixes = (done: Record<string, any>) =>
      fixCodes(done).filter((code) => ["CHECKOUT_BEHIND", "GATEWAY_OUTDATED"].includes(code));

    const same = await at("tree-1");
    expect(same["data"]).toMatchObject({
      upToDate: true,
      checkout: { version: "0.2.0", treeSha256: "tree-1" },
    });
    expect(checkoutFixes(same)).toEqual([]);
    expect(await shown()).toMatch(/\nRelease +0\.2\.0 · matches this checkout\n/);

    // Committed since: good to know, with the command that updates it now
    // (never setup, which is for installing); the next rebind brings it anyway.
    const newer = await at("tree-2", Date.parse("2026-10-20T00:00:00Z"));
    expect(newer["data"]["upToDate"]).toBe(false);
    expect(newer["data"]["fixes"]).toContainEqual({
      code: "GATEWAY_OUTDATED",
      severity: "info",
      message:
        "Your every-app folder has a newer Gateway than the one online\nRun update to take it; deploying an app never changes the Gateway.",
      run: "pnpm everyapp update",
      note: "updates it now",
    });
    const updatable = await shown();
    expect(updatable).toMatch(/\nRelease +0\.2\.0 · from .*every-app-gateway-release\.tar\.gz · this checkout has newer Gateway changes\n/);
    expect(updatable).toContain(
      [
        "i Your every-app folder has a newer Gateway than the one online",
        "  Run update to take it; deploying an app never changes the Gateway.",
        "  Run: pnpm everyapp update  updates it now",
      ].join("\n"),
    );

    // Behind the live one: git pull.
    const behind = await at("tree-0", Date.parse("2026-01-01T00:00:00Z"), "0.1.0");
    expect(behind["data"]["upToDate"]).toBe(false);
    expect(checkoutFixes(behind)).toEqual(["CHECKOUT_BEHIND"]);
    expect(behind["data"]["fixes"]).toContainEqual(
      expect.objectContaining({ code: "CHECKOUT_BEHIND", run: "git pull" }),
    );
    const report = await shown();
    expect(report).toMatch(/\nRelease +0\.2\.0 · this checkout is behind\n/);
    expect(report).toContain(
      "! This checkout is behind the live Gateway\n  This checkout has 0.1.0; 0.2.0 is live.\n  Deploys from here are refused until it catches up.\n  Run: git pull",
    );

    // Without a tree hash, it can't say.
    const unknown = await at(null);
    expect(unknown["data"]["upToDate"]).toBeNull();
    expect(checkoutFixes(unknown)).toEqual([]);

    // Nor without a checkout (a CLI installed from npm): nothing to compare.
    checkout = null;
    const published = await status();
    expect(published["data"]).toMatchObject({ upToDate: null, checkout: null });
    expect(checkoutFixes(published)).toEqual([]);
  });

  it("counts an available Gateway update as nothing to fix, and keeps the note under --json", async () => {
    // The owner claimed, so the update is the only item.
    new GatewayWorker(account).claim(
      (await mintSetupLink({ db: db(), gatewayUrl: "https://example.com" })).url,
    );
    account.database("every-app-gateway").sqlite.exec(
      "UPDATE _everyapp_install SET source_tree_sha256 = 'tree-1'",
    );
    const source = await releaseSource(tarball);
    checkout = async () => ({
      ...source,
      treeSha256: "tree-2",
      order: { ...source.order, committedAt: Date.parse("2026-10-20T00:00:00Z") },
    });

    const done = await status();

    expect(done["message"]).toBe("Gateway https://example.com: 0 apps live, nothing to fix");
    expect(done["data"]["fixes"]).toEqual([
      {
        code: "GATEWAY_OUTDATED",
        severity: "info",
        message: expect.stringMatching(/^Your every-app folder has a newer Gateway than the one online\n/),
        run: "pnpm everyapp update",
        note: "updates it now",
      },
    ]);
    // A real problem still counts, and its note travels the same way.
    account.workers.get("every-app-gateway")!.versions.push("dashboard-1");
    const changed = await status();
    expect(changed["message"]).toBe("Gateway https://example.com: 0 apps live, 1 problem to fix");
    expect(changed["data"]["fixes"]).toContainEqual(
      expect.objectContaining({ code: "GATEWAY_CHANGED", run: "pnpm everyapp setup", note: "redeploys 0.2.0, asking first" }),
    );
  });

  it("says whether Cloudflare Access is in front, and whether it is in step with this Gateway", async () => {
    const gatewayWorker = () => account.workers.get("every-app-gateway")!;
    const nothing = { drift: null, driftUnread: null };
    let refuseList: string | null = null;
    account.cf.override(
      (args) => refuseList !== null && args[0] === "zero-trust" && args[2] === "applications" && args[3] === "list",
      () => ({ exitCode: 1, stderr: refuseList! }),
    );

    // Off: none of the settings on the Worker, and nothing asked of Zero Trust.
    const off = await status();
    expect(off["data"]["access"]).toEqual({ on: false, teamDomain: null, ...nothing });
    expect(await shown()).toMatch(
      /\nOwner +none yet\nAccess +off\nRelease /,
    );
    expect(account.cf.calls.some((call) => call.args[0] === "zero-trust")).toBe(false);

    // Two of three: still off (the Gateway needs all three).
    gatewayWorker().secrets["CLOUDFLARE_ACCESS_TEAM_DOMAIN"] = "acme.cloudflareaccess.com";
    gatewayWorker().secrets["CLOUDFLARE_ACCESS_AUD"] = "a".repeat(64);
    expect((await status())["data"]["access"]).toEqual({ on: false, teamDomain: null, ...nothing });

    // All three, with a record of the team, but nothing at Zero Trust: on,
    // and out of step (the Gateway requires a login nothing asks for).
    for (const name of ACCESS_SETTINGS) gatewayWorker().secrets[name] = gatewayWorker().secrets[name] ?? "b".repeat(64);
    await writeAccessSettingsRecord(db(), {
      teamDomain: "acme.cloudflareaccess.com",
      gatewayAud: "a".repeat(64),
      appsAud: "b".repeat(64),
      writtenAt: Date.parse("2026-10-23T12:00:00Z"),
    });
    const bare = await status();
    expect(bare["data"]["access"]).toEqual({
      on: true,
      teamDomain: "acme.cloudflareaccess.com",
      drift: { paths: [], signIn: [], missing: ["example.com", "*.example.com"], settings: false },
      driftUnread: null,
    });
    expect(bare["data"]["fixes"]).toContainEqual(
      expect.objectContaining({
        code: "ACCESS_DRIFT",
        severity: "warning",
        message: expect.stringContaining("No Access application in front of example.com and *.example.com."),
        run: "pnpm everyapp access on",
        note: "brings Access in step with this Gateway",
      }),
    );
    expect(await shown()).toMatch(/\nAccess +on · drift: no application in front of example\.com and \*\.example\.com\n/);

    // `access on` makes the ring (once the owner exists): in step, nothing to fix.
    new GatewayWorker(account).claim((await mintSetupLink({ db: db(), gatewayUrl: "https://example.com" })).url);
    await turnAccessOn({
      flags: { json: true, gateway: "https://example.com" },
      out: createNdjsonSink(() => undefined),
      createCf: () => account.cf,
      team: "acme",
      interactive: false,
    });
    const on = await status();
    expect(on["data"]["access"]).toEqual({
      on: true,
      teamDomain: "acme.cloudflareaccess.com",
      drift: { paths: [], signIn: [], missing: [], settings: false },
      driftUnread: null,
    });
    expect(fixCodes(on)).not.toContain("ACCESS_DRIFT");
    expect(await shown()).toMatch(/\nAccess +on · in step with this Gateway · everyone signs in through Cloudflare Access first\n/);

    // Drift by hand: the Gateway host's paths, the apps application's
    // sign-in methods. Named, with the command that brings them back.
    type Destination = { uri: string; overrides: Array<{ path_pattern: string }> };
    const application = (uri: string) =>
      [...account.zeroTrust.applications.values()].find((app) =>
        (app["destinations"] as Destination[]).some((d) => d.uri === uri),
      )!;
    const gatewayDestination = (application("example.com")["destinations"] as Destination[]).find((d) => d.uri === "example.com")!;
    gatewayDestination.overrides = gatewayDestination.overrides.filter((o) => o.path_pattern !== "/health");
    application("*.example.com")["allowed_idps"] = [];
    const drifted = await status();
    expect(drifted["data"]["access"]["drift"]).toEqual({ paths: ["example.com"], signIn: ["*.example.com"], missing: [], settings: false });
    expect(drifted["data"]["fixes"]).toContainEqual(
      expect.objectContaining({
        code: "ACCESS_DRIFT",
        message: [
          "Cloudflare Access is out of step with this Gateway",
          "The paths let through without a login differ on example.com.",
          "The sign-in methods differ on *.example.com.",
        ].join("\n"),
      }),
    );
    expect(drifted["message"]).toContain("1 problem to fix");
    expect(await shown()).toMatch(/\nAccess +on · drift: paths differ on example\.com; sign-in methods differ on \*\.example\.com\n/);

    // The Gateway's application recreated by hand: the recorded settings name another one.
    const old = application("example.com");
    account.zeroTrust.applications.delete(old["id"] as string);
    account.zeroTrust.applications.set("app-new", { ...old, id: "app-new", aud: "f".repeat(64) });
    const recreated = await status();
    expect(recreated["data"]["access"]["drift"]["settings"]).toBe(true);
    expect(recreated["data"]["fixes"]).toContainEqual(
      expect.objectContaining({
        code: "ACCESS_DRIFT",
        message: expect.stringContaining("name other applications than the ones found"),
      }),
    );
    expect(await shown()).toContain("the settings name other applications");

    // A login that can't read Access: on, in step unknown, and no problem for it.
    refuseList = "┌ APIError\n│ [10000] Authentication error\n└\n";
    const unreadable = await status();
    expect(unreadable["data"]["access"]).toMatchObject({ on: true, drift: null, driftUnread: { permission: true } });
    expect(fixCodes(unreadable)).not.toContain("ACCESS_DRIFT");
    expect(fixCodes(unreadable)).not.toContain("ACCESS_DRIFT_UNKNOWN");
    expect(await shown()).toMatch(/\nAccess +on · in step\? this login can't read Access\n/);

    // Any other refusal: a problem that says what Cloudflare said.
    refuseList = "┌ APIError\n│ [12060] access.api.error.invalid_request\n│ 400 Bad Request\n└\n";
    const failed = await status();
    expect(failed["data"]["access"]).toMatchObject({ on: true, drift: null, driftUnread: { permission: false } });
    expect(failed["data"]["fixes"]).toContainEqual(
      expect.objectContaining({
        code: "ACCESS_DRIFT_UNKNOWN",
        severity: "warning",
        message: expect.stringContaining("Couldn't check whether Cloudflare Access is in step with this Gateway\nCloudflare said: "),
        run: null,
      }),
    );
    expect(await shown()).toMatch(/\nAccess +on · in step\? couldn't check\n/);
    refuseList = null;

    // cf can't list the Worker's settings: the row says so, and a problem says why.
    account.cf.override(["workers", "secrets", "list"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });
    const unknown = await status();
    expect(unknown["data"]["access"]).toBeNull();
    expect(fixCodes(unknown)).toContain("ACCESS_UNKNOWN");
    const report = await shown();
    expect(report).toMatch(/\nAccess +! couldn't check\n/);
    expect(report).toContain("! Couldn't check whether Cloudflare Access is on\n  Cloudflare said: ");
  });

  it("has no Access row for a hosted Gateway, which ignores the settings", async () => {
    account.database("every-app-gateway").sqlite.exec(
      "UPDATE _everyapp_install SET deployment_mode = 'hosted'",
    );

    const done = await status();

    expect(done["data"]).toMatchObject({ mode: "hosted", access: null });
    expect(fixCodes(done)).not.toContain("ACCESS_UNKNOWN");
    expect(nextCodes(done)).not.toContain("ACCESS_OFF");
    expect(await shown()).not.toMatch(/\nAccess /);
  });

  it("says what to do next from the Gateway's state, never what a fix says already, and at most four things", async () => {
    const gatewayWorker = () => account.workers.get("every-app-gateway")!;
    const sqlite = account.database("every-app-gateway").sqlite;

    // Fresh and unclaimed: nothing to open, and the fix says setup. Access
    // waits for the owner (`access on` refuses with nobody to let in), and
    // the owner's counts aren't read before there is one.
    const fresh = await status();
    expect(fresh["data"]["next"]).toEqual([
      {
        code: "CREATE_APP",
        command: "pnpm everyapp create ../my-app",
        note: "start your first app",
        why: "No apps yet.",
      },
    ]);
    // After the fixes, in setup's style: the command, then the note.
    expect(await shown()).toContain(
      [
        "  Run: pnpm everyapp setup",
        "",
        "Next:",
        "  pnpm everyapp create ../my-app  start your first app",
        "",
      ].join("\n"),
    );

    // The owner claims (so Access is now worth turning on); crm (AI
    // optional) and todo go live, todo serving tools; the DataForSEO key is
    // set while the MCP app is off.
    const { userId, organizationId } = new GatewayWorker(account).claim(
      (await mintSetupLink({ db: db(), gatewayUrl: "https://example.com" })).url,
    );
    await deployed("crm", {
      manifest: { id: "crm", providers: [{ id: "openrouter", why: "Drafts replies.", optional: true }] },
    });
    const todo = await deployed("todo");
    for (const host of ["crm", "todo"]) await new GatewayWorker(account).fetch(`https://${host}.example.com/`);
    gatewayWorker().secrets["DATAFORSEO_API_KEY"] = "login:password";
    sqlite
      .prepare(
        "INSERT INTO app_tool_catalogs (app_row_id, organization_id, status, tool_count, fetched_at) VALUES (?, ?, 'ok', 3, ?)",
      )
      .run(todo.id, organizationId, Date.now());

    const done = await status();
    expect(done["data"]["next"]).toEqual([
      expect.objectContaining({
        code: "AI_KEY",
        command: "pnpm everyapp secret set OPENROUTER_API_KEY",
        note: "AI for crm",
        why: "crm uses AI once OPENROUTER_API_KEY is set; no AI key is set on the Gateway.",
      }),
      expect.objectContaining({
        code: "PROVIDER_OFFER",
        command: "pnpm everyapp mcp on dataforseo",
        why: "DATAFORSEO_API_KEY is set and DataForSEO is off.",
      }),
      expect.objectContaining({
        code: "ACCESS_OFF",
        command: "pnpm everyapp access on",
        note: "put Cloudflare Access in front (recommended)",
        why: "Cloudflare Access is off; the Gateway's own sign-in is the only check in front of your apps.",
      }),
      expect.objectContaining({
        code: "INVITE",
        url: "https://example.com/admin/users",
        note: "invite people",
        why: "owner@example.com is the only member.",
      }),
    ]);
    expect(fixCodes(done)).toEqual([]);
    expect(done["message"]).toBe("Gateway https://example.com: 2 apps live, nothing to fix");
    expect(await shown()).toContain(
      [
        "Next:",
        "  pnpm everyapp secret set OPENROUTER_API_KEY  AI for crm",
        "  pnpm everyapp mcp on dataforseo              offer DataForSEO's tools to AI clients (each call spends DataForSEO credit)",
        "  pnpm everyapp access on                      put Cloudflare Access in front (recommended)",
        "  https://example.com/admin/users              invite people",
      ].join("\n"),
    );

    // With Access on, the fifth step takes the fourth place: no AI client
    // is connected while an app serves tools.
    for (const name of ACCESS_SETTINGS) gatewayWorker().secrets[name] = "b".repeat(64);
    const accessOn = await status();
    expect(nextCodes(accessOn)).toEqual(["AI_KEY", "PROVIDER_OFFER", "INVITE", "CONNECT_AI"]);
    expect(accessOn["data"]["next"]).toContainEqual({
      code: "CONNECT_AI",
      url: "https://everyapp.com/docs/connect-ai",
      note: "connect an AI client to https://example.com/mcp",
      why: "No AI client is connected; 1 app serves tools.",
    });

    // A fix that names the key already: openseo needs it, so AI_KEY goes.
    await deployed("openseo", {
      manifest: { id: "openseo", providers: [{ id: "openrouter", why: "Writes audits." }] },
    });
    await new GatewayWorker(account).fetch("https://openseo.example.com/");
    const needsSetup = await status();
    expect(fixCodes(needsSetup)).toContain("APP_NEEDS_SETUP");
    expect(nextCodes(needsSetup)).toEqual(["PROVIDER_OFFER", "INVITE", "CONNECT_AI"]);

    // A connected client, the provider on, the key set: each line goes with its state.
    sqlite
      .prepare(
        "INSERT INTO mcp_connections (id, user_id, organization_id, client_id, client_name, redirect_uri, redirect_host, app_scope, access, created_at) VALUES (?, ?, ?, 'client-1', 'Claude', 'https://claude.ai/callback', 'claude.ai', 'all', 'write', ?)",
      )
      .run(`mcpc_${"a".repeat(32)}`, userId, organizationId, Date.now());
    gatewayWorker().secrets["OPENROUTER_API_KEY"] = "sk-or";
    sqlite
      .prepare(
        "INSERT INTO apps (id, organization_id, app_slug, name, description, tier, manifest, status, is_default, created_at, updated_at, scope) VALUES ('app_dataforseo', ?, 'dataforseo', 'DataForSEO', 'SEO data', 'provider', '{}', 'active', 0, ?, ?, 'org')",
      )
      .run(organizationId, Date.now(), Date.now());
    const connected = await status();
    expect(nextCodes(connected)).toEqual(["INVITE"]);
    // Someone is invited and hasn't joined: the owner has done their part.
    // An expired invitation counts for nothing.
    sqlite
      .prepare(
        "INSERT INTO invitations (id, organization_id, email, status, expires_at, inviter_id) VALUES ('inv-sam', ?, 'sam@example.com', 'pending', ?, ?)",
      )
      .run(organizationId, Date.now() + 86_400_000, userId);
    expect(nextCodes(await status())).toEqual([]);
    sqlite.prepare("UPDATE invitations SET expires_at = ? WHERE id = 'inv-sam'").run(Date.now() - 1);
    expect(nextCodes(await status())).toEqual(["INVITE"]);
    // An MCP app on without its key asks for it.
    delete gatewayWorker().secrets["DATAFORSEO_API_KEY"];
    expect((await status())["data"]["next"]).toContainEqual({
      code: "PROVIDER_KEY",
      command: "pnpm everyapp secret set DATAFORSEO_API_KEY",
      note: "DataForSEO is on and needs its key",
      why: 'DataForSEO shows "needs setup" and serves no tools until DATAFORSEO_API_KEY is set.',
    });

    // A Gateway from before one of the counted tables: the counts go
    // unread, the rules that need them are skipped, and nothing is raised.
    sqlite.exec("DROP TABLE mcp_connections");
    const older = await status();
    expect(events.filter((event) => event["type"] === "warning" || event["type"] === "error")).toEqual([]);
    expect(nextCodes(older)).toEqual(["PROVIDER_KEY"]);
  });

  it("logs in through cf's device link under --json, and waits for it", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    let approved = false;
    account.cf
      .override(["auth", "whoami"], () => ({
        stdout: JSON.stringify(
          approved
            ? { authenticated: true, email: "dev@example.com", accounts: [{ id: ACCOUNT_ID, name: "Acme" }] }
            : { authenticated: false },
        ),
      }))
      .override(["auth", "login"], () => {
        approved = true;
        return {
          stdout: "please visit:\n\n  https://dash.cloudflare.com/oauth2/device\n\nand enter the code:\n\n  ABCD-EFGH\n",
        };
      });
    events = [];

    const gateway = await existingGateway({
      json: true,
      out: out(),
      createCf: () => account.cf,
    });

    expect(gateway.account.id).toBe(ACCOUNT_ID);
    expect(events).toEqual([
      expect.objectContaining({
        type: "action_required",
        action: "cloudflare_login",
        data: { url: "https://dash.cloudflare.com/oauth2/device", code: "ABCD-EFGH", expiresAt: expect.any(String), waiting: true, waitingFor: "Cloudflare login" },
      }),
    ]);
  });

  it("says when the install stopped before its first upload, or before recording itself", async () => {
    // A new install recorded itself, then stopped before the upload (no
    // workers.dev subdomain yet, say).
    const fresh = new FakeCloudflare();
    await applyGatewayTo(fresh, { failUpload: true });

    events = [];
    await reportStatus({ gateway: await found(fresh), out: out(), checkout });
    // Nobody can have claimed it: one problem, which setup finishes.
    expect(fixCodes(events.at(-1)!)).toEqual(["GATEWAY_NOT_UPLOADED"]);
    const report = await shown(fresh);
    expect(report).toMatch(/\nRelease +0\.2\.0, never uploaded\n/);
    expect(report).toMatch(/\nTLS +no hostnames yet\n/);
    expect(report).toMatch(/\nNo apps yet\.\n/);
    expect(report).toContain(
      "! The Gateway's install stopped before its first upload\n  Setup finishes it, then prints the link that creates the owner account.\n  Run: pnpm everyapp setup",
    );

    // A database with no install row at all.
    fresh.database("every-app-gateway").sqlite.exec("DROP TABLE _everyapp_install");
    events = [];
    await reportStatus({ gateway: await found(fresh), out: out(), checkout });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: {
        installed: false,
        fixes: [{ code: "GATEWAY_NOT_INSTALLED", run: "pnpm everyapp setup" }],
      },
    });
    expect(await shown(fresh)).toBe(
      [
        "Cloudflare  Acme",
        "Gateway     install not finished",
        "",
        "! Setup stopped before it recorded the Gateway's install",
        "  The Gateway's database exists, but nothing else was recorded.",
        "  Run: pnpm everyapp setup  asks for the hostname again",
        "",
      ].join("\n"),
    );
  });

  it("is a first run when no account the login sees has a Gateway: install one", async () => {
    await expect(
      existingGateway({ out: out(), createCf: () => new FakeCloudflare().cf }),
    ).rejects.toMatchObject({
      action: "install_gateway",
      message: expect.stringMatching(
        /^No Gateway in Acme's Cloudflare account( \(logged in as .+\))?\nGateway in another account\? Log in to it: pnpm everyapp login$/,
      ),
      rerun: "pnpm everyapp setup",
    });
  });
});

/** A gateway install in another fake account; `failUpload` stops it at cf deploy. */
async function applyGatewayTo(
  cloudflare: FakeCloudflare,
  { failUpload = false } = {},
) {
  const resources = await ensureGatewayResources(cloudflare.cf);
  if (failUpload) {
    cloudflare.failNextDeploy = `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;
  }
  await applyGateway({
    cf: cloudflare.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(cloudflare.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...quick,
  }).catch((error: unknown) => {
    if (!failUpload) throw error;
  });
}
