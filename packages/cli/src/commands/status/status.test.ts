/**
 * `everyapp status`, all from the gateway's D1 and cf in a fake
 * account: the install row, the registry, the owner, certificates, running
 * deploys, and what to run when they disagree. Nothing goes to the gateway.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEmailRoutes, planEmailRoutes } from "@/lib/app/emailRoutes";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { discoverGateway } from "@/lib/gateway/discover";
import { LeasePurpose } from "@/lib/gateway/lease";
import { holdLease } from "@/test/holdLease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { markDeployed, register, writeAppEmail } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import type { CandidateRelease } from "@/lib/gateway/release";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { existingGateway } from "@/lib/gateway/connect";
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

const fixCodes = (done: Record<string, any>) =>
  (done["data"]["fixes"] as Array<{ code: string }>).map((fix) => fix.code);

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
    // No owner yet: the one thing to do.
    expect(done["data"]["fixes"]).toEqual([
      expect.objectContaining({ code: "NO_OWNER", run: "pnpm everyapp setup" }),
    ]);
    expect(done["message"]).toMatch(/\ntodo +✓ live +https:\/\/todo\.example\.com/);
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
    expect(done["message"]).toContain(
      "inbox: sends as the Gateway's sender only; receives *@example.com, support@example.com",
    );
    expect(fixCodes(done)).not.toContain("EMAIL_ROUTE_MISSING");
    expect(fixCodes(done)).not.toContain("EMAIL_ROUTE_PENDING");

    // Someone deleted the rule by hand.
    const [rule] = account.emailRulesFor("zone-1", "support@example.com");
    account.emailRoutingOf("zone-1").rules.delete(rule!.id);
    expect((await status())["data"]["fixes"]).toContainEqual({
      code: "EMAIL_ROUTE_MISSING",
      message: "Mail for inbox doesn't reach it: support@example.com (its Email Routing rule is gone).",
      run: "pnpm everyapp deploy (in inbox's directory)",
    });

    // cf can't read the rules: said, and the rest of the report stands.
    account.cf.override(["email-routing"], { exitCode: 1, stderr: "┌ Error\n│ boom\n└\n" });
    const unknown = await status();
    expect(events).toContainEqual(expect.objectContaining({ type: "warning", code: "EMAIL_ROUTES_UNKNOWN" }));
    expect(fixCodes(unknown)).not.toContain("EMAIL_ROUTE_MISSING");
    expect(unknown["data"]["apps"]).toHaveLength(2);
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
    expect(done["message"]).toContain(
      "inbox: sends as *@example.com; receives *@example.com, support@example.com",
    );
    expect(done["data"]["fixes"]).toContainEqual({
      code: "EMAIL_ROUTE_PENDING",
      message: "Mail routes for inbox don't match its addresses: not routed yet: support@example.com.",
      run: "pnpm everyapp deploy (in inbox's directory)",
    });

    // The other way round: a route the list no longer names.
    await writeAppEmail(db(), "inbox", { senders: [], inbound: ["support@example.com"] }, deployer);
    expect((await status())["data"]["fixes"]).toContainEqual(
      expect.objectContaining({
        code: "EMAIL_ROUTE_PENDING",
        message:
          "Mail routes for inbox don't match its addresses: not routed yet: support@example.com; still routed, no longer listed: *@example.com.",
      }),
    );
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
    expect(done["message"]).toContain(
      "inbox: sends as the Gateway's sender only; receives nothing (*@example.com, support@example.com set, not declared)",
    );
    expect(done["data"]["fixes"]).toContainEqual({
      code: "EMAIL_INBOUND_UNDECLARED",
      message:
        "inbox's addresses (*@example.com, support@example.com) are stored, but the manifest it was deployed from doesn't declare email: { inbound: true }, so no mail is routed to it.",
      run: "pnpm everyapp email unset --inbound (in inbox's directory), or pnpm everyapp deploy once everyapp.config.ts declares it",
    });
    expect(fixCodes(done)).not.toContain("EMAIL_ROUTE_PENDING");
  });

  it("prints the deployment mode the install recorded", async () => {
    const done = await status();
    expect(done["data"]["mode"]).toBe("self_hosted");
    expect(done["message"]).toContain("https://example.com · self-hosted");
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

    // The gateway changed outside everyapp: that comes first.
    account.workers.get("every-app-gateway")!.versions.push("dashboard-1");
    expect(fixCodes(await status())).toContain("GATEWAY_CHANGED");
  });

  it("says whether the live Gateway is the one this checkout builds, and what to run when not", async () => {
    // The live release was built from sources that hash to "tree-1".
    account.database("every-app-gateway").sqlite.exec(
      "UPDATE _everyapp_install SET source_tree_sha256 = 'tree-1'",
    );
    const at = async (treeSha256: string | null, committedAt?: number) => {
      const source = await releaseSource(tarball);
      checkout = async () => ({
        ...source,
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
    expect(same["message"]).toContain("matches this checkout");

    // Committed since: the next rebind upgrades it, or setup does now.
    const newer = await at("tree-2", Date.parse("2026-10-20T00:00:00Z"));
    expect(newer["data"]["upToDate"]).toBe(false);
    expect(newer["data"]["fixes"]).toContainEqual(
      expect.objectContaining({ code: "GATEWAY_OUTDATED", run: "pnpm everyapp setup" }),
    );

    // Behind the live one: git pull.
    const behind = await at("tree-0", Date.parse("2026-01-01T00:00:00Z"));
    expect(behind["data"]["upToDate"]).toBe(false);
    expect(checkoutFixes(behind)).toEqual(["CHECKOUT_BEHIND"]);
    expect(behind["data"]["fixes"]).toContainEqual(
      expect.objectContaining({ code: "CHECKOUT_BEHIND", run: "git pull" }),
    );
    expect(behind["message"]).toContain("newer than this checkout");

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
    expect(fixCodes(events.at(-1)!)).toContain("GATEWAY_NOT_UPLOADED");
    expect(fixCodes(events.at(-1)!)).not.toContain("GATEWAY_CHANGED");

    // A database with no install row at all.
    fresh.database("every-app-gateway").sqlite.exec("DROP TABLE _everyapp_install");
    events = [];
    await reportStatus({ gateway: await found(fresh), out: out(), checkout });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      data: {
        installed: false,
        fixes: [expect.objectContaining({ run: expect.stringContaining("everyapp setup") })],
      },
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
