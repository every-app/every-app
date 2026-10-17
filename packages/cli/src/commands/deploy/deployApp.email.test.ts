/**
 * `everyapp deploy` of an app that receives mail (`email.inbound`), end to
 * end in the fake Cloudflare account (test/fakeCloudflare.ts): the
 * addresses checked before anything is created or uploaded, a rule per
 * literal address and the zone's catch-all sending mail to the app's
 * Worker once it is uploaded, each recorded in the gateway's ledger, a
 * dropped address's rule deleted on the next deploy, every route gone
 * with `delete --purge`, and Email Routing turned on for a domain only at
 * a terminal or with --enable-email-routing. The Worker itself never
 * declares the `email` trigger.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
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
  email: { inbound: ["*@example.com", "support@mail.example.com"] },
};

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

const routes = async () =>
  (await readOwnedResources(registry(), WORKER)).filter((resource) => resource.kind === "email-route");

const inboxUploads = () => account.deploys.filter((upload) => upload.workerName === WORKER);

/** Where in the cf calls the first one `match` picks is. */
const callIndex = (match: (args: string[]) => boolean) =>
  account.cf.calls.findIndex((call) => match(call.args));

describe("deploy of an app that receives mail", () => {
  it("routes each address to the Worker once it is uploaded, and records both routes", async () => {
    routeMail();
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
        data: { addresses: ["*@example.com", "support@mail.example.com"], removed: [] },
      }),
    );

    // The Worker has no email trigger: the rules are the only link.
    expect(inboxUploads()[0]!.config["triggers"] ?? []).toEqual([]);
  });

  it("says what replying from those addresses needs, unless senders cover them", async () => {
    routeMail();
    await deploy();
    const step = () => events.findLast((event) => event["step"] === "app.email" && event["status"] === "ok")!;
    expect(step()["message"]).toContain(
      "To reply from example.com, mail.example.com, onboard them to Email Sending and list them in capabilities.email.senders",
    );

    events = [];
    await deploy({
      ...INBOX,
      capabilities: { email: { access: "write", senders: ["*@example.com", "*@mail.example.com"] } },
    });
    expect(step()["message"]).toBe(`Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`);
  });

  it("deletes a dropped address's rule on the next deploy, and every route with --purge", async () => {
    routeMail();
    await deploy();
    events = [];

    await deploy({ ...INBOX, email: { inbound: ["*@example.com"] } });

    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    expect((await routes()).map((route) => route.binding)).toEqual(["*@example.com"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.email",
        status: "ok",
        data: { addresses: ["*@example.com"], removed: ["support@mail.example.com"] },
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

  it("stops unattended before anything is uploaded when routing is off, and turns it on with --enable-email-routing", async () => {
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
    const asked: string[] = [];
    await deploy(INBOX, {
      interactive: true,
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
    });
    expect(asked).toEqual([
      "Turn on Email Routing for example.com, mail.example.com? Cloudflare adds and locks their MX and SPF records, so mail for them goes to Cloudflare from then on.",
    ]);
    expect(account.emailRoutingOf("zone-1").enabled).toBe(true);
  });

  it("refuses an address another rule delivers before anything is created or uploaded", async () => {
    routeMail();
    account.emailRoutingOf("zone-1").rules.set("theirs", {
      id: "theirs",
      name: "helpdesk",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "support@mail.example.com" }],
      actions: [{ type: "forward", value: ["help@vendor.com"] }],
    });

    await expect(deploy()).rejects.toMatchObject({ code: "EMAIL_ADDRESS_TAKEN" });
    expect(inboxUploads()).toEqual([]);
    expect(account.emailRoutingOf("zone-1").catchAll.actions).toEqual([{ type: "drop" }]);
  });

  it("refuses an address another app routes", async () => {
    routeMail();
    await deploy();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-helpdesk-app-"));
    try {
      fs.copyFileSync(path.join(appDir, "cloudflare.config.ts"), path.join(other, "cloudflare.config.ts"));
      const helpdesk: EveryAppCliManifest = { id: "helpdesk", email: { inbound: ["support@mail.example.com"] } };
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
        message: expect.stringContaining(WORKER),
      });
      expect(account.deploys.some((upload) => upload.workerName === "every-acme-helpdesk")).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses the catch-all when it already sends the zone's mail elsewhere", async () => {
    routeMail();
    const routing = account.emailRoutingOf("zone-1");
    routing.catchAll = { ...routing.catchAll, actions: [{ type: "forward", value: ["all@vendor.com"] }] };
    await expect(deploy()).rejects.toMatchObject({ code: "EMAIL_CATCH_ALL_TAKEN" });
    expect(inboxUploads()).toEqual([]);
  });

  it("refuses a domain no zone in the account holds, and a catch-all on a subdomain", async () => {
    routeMail();
    await expect(deploy({ ...INBOX, email: { inbound: ["hi@elsewhere.net"] } })).rejects.toMatchObject({
      code: "EMAIL_ZONE_NOT_FOUND",
    });
    await expect(deploy({ ...INBOX, email: { inbound: ["*@mail.example.com"] } })).rejects.toMatchObject({
      code: "EMAIL_CATCH_ALL_NOT_APEX",
    });
    expect(inboxUploads()).toEqual([]);
  });

  it("adopts a rule on retry when the create's answer was lost", async () => {
    routeMail();
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
