/**
 * `everyapp deploy` of an app that receives mail (`email: { inbound: true }`
 * in the manifest, its addresses on the installation's registry row, as
 * `everyapp email set --inbound` stores them), end to end in the fake
 * Cloudflare account (test/fakeCloudflare.ts): the addresses checked
 * before anything is created or uploaded, a rule per literal address and
 * the zone's catch-all sending mail to the app's Worker once it is
 * uploaded, each recorded in the gateway's ledger, a dropped address's
 * rule deleted on the next deploy, every route gone with `delete --purge`,
 * and Email Routing turned on for a domain only at a terminal or with
 * --enable-email-routing. The Worker itself never declares the `email`
 * trigger.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppEmailConfig } from "@every-app/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readAppEmail, register, writeAppEmail, type Deployer } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const WORKER = "every-acme-inbox";

const INBOX: EveryAppCliManifest = {
  id: "inbox",
  resources: {
    durableObjects: [{ name: "MAILBOX", className: "MailboxDO" }],
  },
  capabilities: { email: { access: "write" } },
  email: { inbound: true },
};
const INBOUND = ["*@example.com", "support@mail.example.com"];
/** An API token: `email: null` skips the platform-admin check. */
const DEPLOYER: Deployer = { actor: "api-token:acc", email: null };

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};

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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-inbox-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

/** Email Routing on for example.com and mail.example.com, as an operator left it. */
function routeMail() {
  account.emailRoutingOf("zone-1").enabled = true;
  account.dnsRecords.push({
    zoneId: "zone-1",
    name: "mail.example.com",
    type: "MX",
    content: "route1.mx.cloudflare.net",
  });
}

function deploy(
  manifest: EveryAppCliManifest = INBOX,
  options: Partial<Parameters<typeof deployApp>[0]> = {},
) {
  account.apps.set(appDir, manifest);
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
    interactive: false,
    ...options,
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

/** The installation's lists, as `everyapp email set` stores them. */
const setEmail = (config: Partial<AppEmailConfig>, appSlug = "inbox") =>
  writeAppEmail(registry(), appSlug, { senders: [], inbound: [], ...config }, DEPLOYER);

/**
 * The lists set before the first upload: the app registered (its Worker
 * pending, as `everyapp email set` finds it), the row written.
 */
async function seed(config: Partial<AppEmailConfig>, manifest: EveryAppCliManifest = INBOX) {
  await register(registry(), {
    appSlug: manifest.id,
    name: manifest.id,
    description: manifest.id,
    manifest,
    appBaseDomain: "example.com",
    deployer: DEPLOYER,
    organizationName: "Acme",
  });
  return setEmail(config, manifest.id);
}

const routes = async () =>
  (await readOwnedResources(registry(), WORKER)).filter((resource) => resource.kind === "email-route");

const inboxUploads = () => account.deploys.filter((upload) => upload.workerName === WORKER);

/** Where in the cf calls the first one `match` picks is. */
const callIndex = (match: (args: string[]) => boolean) =>
  account.cf.calls.findIndex((call) => match(call.args));

const emailStep = (status: string) =>
  events.findLast((event) => event["step"] === "app.email" && event["status"] === status);

describe("deploy of an app that receives mail", () => {
  it("routes each address to the Worker once it is uploaded, and records both routes", async () => {
    routeMail();
    // The first deploy, before any address is set: one hint, no routing.
    await deploy();
    expect(emailStep("skip")).toMatchObject({
      type: "step",
      message: "inbox receives no mail yet.",
    });
    expect(account.cf.calls.filter((call) => call.args[0] === "email-routing")).toEqual([]);
    expect(await routes()).toEqual([]);

    await setEmail({ inbound: INBOUND });
    account.cf.calls.length = 0;
    events = [];
    await deploy();

    const routing = account.emailRoutingOf("zone-1");
    const [support] = account.emailRulesFor("zone-1", "support@mail.example.com");
    expect(routing.rules.size).toBe(1);
    expect(support).toMatchObject({
      name: `everyapp:${WORKER}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "support@mail.example.com" }],
      actions: [{ type: "worker", value: [WORKER] }],
    });
    expect(routing.catchAll).toMatchObject({
      name: `everyapp:${WORKER}`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [WORKER] }],
    });
    expect(await routes()).toEqual([
      expect.objectContaining({ binding: "*@example.com", name: "*@example.com", resourceId: "catch_all:zone-1" }),
      expect.objectContaining({
        binding: "support@mail.example.com",
        name: "support@mail.example.com",
        resourceId: `zone-1/${support!.id}`,
      }),
    ]);

    // Checked before the upload, made after it, before the registry records the version.
    const upload = account.cf.calls.findIndex(
      (call) => call.args[0] === "deploy" && call.cwd === appDir,
    );
    expect(upload).toBeGreaterThan(-1);
    expect(callIndex((args) => args[0] === "email-routing" && args[1] === "settings")).toBeLessThan(upload);
    expect(callIndex((args) => args[2] === "create" && args[0] === "email-routing")).toBeGreaterThan(upload);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "step",
        step: "app.email",
        status: "ok",
        message: expect.stringContaining(`Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`),
        data: expect.objectContaining({ addresses: ["*@example.com", "support@mail.example.com"], removed: [] }),
      }),
    );
    expect(emailStep("skip")).toBeUndefined();

    // The Worker has no email trigger: the rules are the only link.
    expect(inboxUploads()[0]!.config["triggers"] ?? []).toEqual([]);
  });

  it("says what replying from those addresses needs, unless senders cover them", async () => {
    routeMail();
    await seed({ inbound: INBOUND });
    await deploy();
    expect(emailStep("ok")!["message"]).toContain(
      "To reply from example.com, mail.example.com, onboard them to Email Sending and list them with `pnpm everyapp email set --sender`",
    );

    await setEmail({ senders: ["*@example.com", "*@mail.example.com"], inbound: INBOUND });
    events = [];
    await deploy();
    expect(emailStep("ok")!["message"]).toBe(`Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`);

    // An app that doesn't declare sending can't take senders, so no hint names `email set --sender`.
    await setEmail({ inbound: INBOUND });
    events = [];
    await deploy({ ...INBOX, capabilities: {} });
    expect(emailStep("ok")!["message"]).toBe(`Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`);

    // Nor on a hosted Gateway, which takes none.
    await registry().run([{ sql: "UPDATE _everyapp_install SET deployment_mode = 'hosted'" }]);
    events = [];
    await deploy();
    expect(emailStep("ok")!["message"]).toBe(`Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`);
  });

  it("deletes a dropped address's rule on the next deploy, and every route with --purge", async () => {
    routeMail();
    await seed({ inbound: INBOUND });
    await deploy();
    events = [];

    await setEmail({ inbound: ["*@example.com"] });
    await deploy();

    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    expect((await routes()).map((route) => route.binding)).toEqual(["*@example.com"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.email",
        status: "ok",
        data: expect.objectContaining({ addresses: ["*@example.com"], removed: ["support@mail.example.com"] }),
      }),
    );

    const result = await removeApp({
      appId: "inbox",
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: rebind,
    });

    expect(result.purged?.removed).toContain("the catch-all of example.com (it drops mail again)");
    expect(account.emailRoutingOf("zone-1").catchAll).toMatchObject({
      enabled: false,
      actions: [{ type: "drop" }],
    });
    expect(await routes()).toEqual([]);
    // The routes went before the Worker they name.
    const reset = account.cf.calls.findLastIndex(
      (call) => call.args.slice(0, 4).join(" ") === "email-routing rules catch-all update",
    );
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(callIndex((args) => args[0] === "workers" && args[1] === "delete"));
  });

  it("removes the routes and keeps the addresses when the manifest drops the declaration", async () => {
    routeMail();
    const { id } = await seed({ inbound: INBOUND });
    await deploy();
    events = [];

    await deploy({ ...INBOX, email: {} });

    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    expect(account.emailRoutingOf("zone-1").catchAll).toMatchObject({ enabled: false, actions: [{ type: "drop" }] });
    expect(await routes()).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "EMAIL_INBOUND_UNDECLARED",
        message:
          "everyapp.config.ts no longer declares inbound email; removing the app's mail routes\nIts addresses (*@example.com, support@mail.example.com) stay on the Gateway until you clear them.",
        data: { rerun: "pnpm everyapp email unset inbound" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.email",
        status: "ok",
        message: "inbox receives no mail. Removed the routes for *@example.com, support@mail.example.com.",
        data: expect.objectContaining({ addresses: [], removed: ["*@example.com", "support@mail.example.com"] }),
      }),
    );
    // The list stays: declaring inbound again routes it.
    await expect(readAppEmail(registry(), id)).resolves.toEqual({ senders: [], inbound: INBOUND });
  });

  it("ends with how to route mail on a deploy of an app that declares inbound with no addresses", async () => {
    await expect(deploy()).resolves.toMatchObject({
      next: [
        { command: "pnpm everyapp email set --inbound <address>", note: "routes mail to inbox" },
        { command: "pnpm everyapp email set --sender '*@<domain>'", note: "lets inbox send as your domain" },
      ],
    });
    const hints = events.filter((event) => event["step"] === "app.email");
    expect(hints).toEqual([
      expect.objectContaining({
        type: "step",
        status: "skip",
        message: "inbox receives no mail yet.",
      }),
    ]);
    // Nothing for an app that doesn't declare inbound mail.
    events = [];
    await deploy({ ...INBOX, email: {} });
    expect(events.filter((event) => event["step"] === "app.email")).toEqual([]);
  });

  it("ends with how to send as your own domain on a deploy of an app that declares sending with no senders stored", async () => {
    const sender = {
      command: "pnpm everyapp email set --sender '*@<domain>'",
      note: "lets inbox send as your domain",
    };
    // An app that only sends: the one hint, until a sender is stored.
    const mailer: EveryAppCliManifest = { ...INBOX, email: {} };
    await expect(deploy(mailer)).resolves.toMatchObject({ next: [sender] });
    await setEmail({ senders: ["*@example.com"] });
    await expect(deploy(mailer)).resolves.toMatchObject({ next: [] });

    // An app that doesn't declare sending takes no senders, so no hint names them.
    await setEmail({});
    await expect(deploy({ ...mailer, capabilities: {} })).resolves.toMatchObject({ next: [] });

    // Nor does a hosted Gateway, which sends all app mail from its own sender.
    await registry().run([{ sql: "UPDATE _everyapp_install SET deployment_mode = 'hosted'" }]);
    await expect(deploy(mailer)).resolves.toMatchObject({ next: [] });
  });

  it("stops unattended before anything is uploaded when routing is off, and turns it on with --enable-email-routing", async () => {
    await seed({ inbound: INBOUND });
    await expect(deploy()).rejects.toMatchObject({
      code: "EMAIL_ROUTING_DISABLED",
      authorize: true,
      rerun: expect.stringContaining("--enable-email-routing"),
      data: { domains: ["example.com", "mail.example.com"] },
    });
    expect(inboxUploads()).toEqual([]);
    expect(account.emailRoutingOf("zone-1").enabled).toBe(false);

    await deploy(INBOX, { enableEmailRouting: true });

    expect(account.emailRoutingOf("zone-1").enabled).toBe(true);
    expect(
      account.dnsRecords.filter((record) => record.name === "mail.example.com" && record.type === "MX"),
    ).toHaveLength(3);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
    expect(await routes()).toHaveLength(2);
  });

  it("asks at a terminal before turning routing on", async () => {
    await seed({ inbound: INBOUND });
    const asked: string[] = [];
    await deploy(INBOX, {
      interactive: true,
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
    });
    expect(asked).toEqual([
      "Turn on Email Routing for example.com, mail.example.com?",
    ]);
    expect(account.emailRoutingOf("zone-1").enabled).toBe(true);
  });

  it("refuses an address another rule delivers before anything is created or uploaded", async () => {
    routeMail();
    await seed({ inbound: INBOUND });
    account.emailRoutingOf("zone-1").rules.set("theirs", {
      id: "theirs",
      name: "helpdesk",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "support@mail.example.com" }],
      actions: [{ type: "forward", value: ["help@vendor.com"] }],
    });

    await expect(deploy()).rejects.toMatchObject({
      code: "EMAIL_ADDRESS_TAKEN",
      message: expect.stringMatching(/^support@mail\.example\.com already forwards to help@vendor\.com\n/),
      fix: "remove that rule, or pick another address",
    });
    expect(inboxUploads()).toEqual([]);
    expect(account.emailRoutingOf("zone-1").catchAll.actions).toEqual([{ type: "drop" }]);
  });

  it("refuses an address another app routes", async () => {
    routeMail();
    await seed({ inbound: INBOUND });
    await deploy();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-helpdesk-app-"));
    try {
      fs.copyFileSync(path.join(appDir, "cloudflare.config.ts"), path.join(other, "cloudflare.config.ts"));
      const helpdesk: EveryAppCliManifest = { id: "helpdesk", email: { inbound: true } };
      await seed({ inbound: ["support@mail.example.com"] }, helpdesk);
      account.apps.set(other, helpdesk);
      await expect(
        deployApp({
          cwd: other,
          manifest: helpdesk,
          out: out(),
          createCf: () => account.cf,
          installDeps: async () => undefined,
          reconcile: rebind,
          live: { fetch: worker.fetch, sleep: async () => undefined },
          interactive: false,
        }),
      ).rejects.toMatchObject({
        code: "EMAIL_ADDRESS_TAKEN",
        message: "support@mail.example.com already goes to another app (inbox)",
        fix: "pick another address, or run pnpm everyapp email unset inbound in inbox's directory first",
      });
      expect(account.deploys.some((upload) => upload.workerName === "every-acme-helpdesk")).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses the catch-all when it already sends the zone's mail elsewhere", async () => {
    routeMail();
    await seed({ inbound: INBOUND });
    const routing = account.emailRoutingOf("zone-1");
    routing.catchAll = { ...routing.catchAll, actions: [{ type: "forward", value: ["all@vendor.com"] }] };
    await expect(deploy()).rejects.toMatchObject({
      code: "EMAIL_CATCH_ALL_TAKEN",
      fix: expect.stringContaining("or list addresses one by one"),
    });
    expect(inboxUploads()).toEqual([]);
  });

  it("refuses a domain no zone in the account holds, and a catch-all on a subdomain", async () => {
    routeMail();
    await seed({ inbound: ["hi@elsewhere.net"] });
    await expect(deploy()).rejects.toMatchObject({
      code: "EMAIL_ZONE_NOT_FOUND",
      fix: expect.stringContaining("or pick an address on another domain"),
    });
    await setEmail({ inbound: ["*@mail.example.com"] });
    await expect(deploy()).rejects.toMatchObject({
      code: "EMAIL_CATCH_ALL_NOT_APEX",
      fix: "list each address instead, e.g. --inbound support@mail.example.com",
    });
    expect(inboxUploads()).toEqual([]);
  });

  it("adopts a rule on retry when the create's answer was lost", async () => {
    routeMail();
    await seed({ inbound: INBOUND });
    let creates = 0;
    account.cf.override(["email-routing", "rules", "create"], (call) => {
      creates += 1;
      // Cloudflare made the rule; its answer never came back.
      const body = JSON.parse(call.files["rule.json"]!);
      account.emailRoutingOf("zone-1").rules.set("lost-rule", { id: "lost-rule", ...body });
      return { exitCode: 1, stderr: "┌ Error\n│ socket hang up\n└\n" };
    });

    await expect(deploy()).rejects.toThrow(/socket hang up/);
    // The address was claimed before the create.
    expect(await routes()).toContainEqual(
      expect.objectContaining({ binding: "support@mail.example.com", resourceId: null }),
    );

    await deploy();

    expect(creates).toBe(1);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com").map((rule) => rule.id)).toEqual([
      "lost-rule",
    ]);
    expect(await routes()).toContainEqual(
      expect.objectContaining({ binding: "support@mail.example.com", resourceId: "zone-1/lost-rule" }),
    );
  });

  it("never lets the Worker declare the email trigger itself", async () => {
    routeMail();
    await seed({ inbound: INBOUND });
    account.editBuild = (config) => {
      config["triggers"] = [{ type: "email", addresses: ["*@example.com"] }];
    };
    await expect(deploy()).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining('declares a trigger of type "email"'),
    });
    expect(inboxUploads()).toEqual([]);
  });
});
