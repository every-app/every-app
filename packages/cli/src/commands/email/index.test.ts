/**
 * `everyapp email set|unset|show` end to end, in a fake Cloudflare account
 * with a deployed gateway and apps (as secret/index.test.ts): the lists
 * land on the app's registry row, the inbound addresses are routed the
 * moment they are set with the checks `deploy` runs, refusals come before
 * anything is read or changed, and `show` says what the Gateway holds
 * against what the manifest declares.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { acquireLease } from "@/lib/gateway/lease";
import { readApp, register, type Deployer } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { loseLeaseAtCheck } from "@/test/loseLease";
import { deployApp } from "../deploy/deployApp";
import { setEmail, showEmail, unsetEmail } from "./index";

const GATEWAY = "every-app-gateway";
const WORKER = "every-acme-inbox";

/** An app that sends and receives mail. */
const INBOX: EveryAppCliManifest = {
  id: "inbox",
  resources: { durableObjects: [{ name: "MAILBOX", className: "MailboxDO" }] },
  capabilities: { email: { access: "write" } },
  email: { inbound: true },
};
/** An app that only sends. */
const MAILER: EveryAppCliManifest = { id: "mailer", capabilities: { email: { access: "write" } } };
/** An app that does neither. */
const NOTES: EveryAppCliManifest = { id: "notes" };

const INBOUND = ["*@example.com", "support@mail.example.com"];
const SENDERS = ["*@example.com", "ceo@example.com"];
/** An API token: `email: null` skips the platform-admin check. */
const DEPLOYER: Deployer = { actor: "api-token:acc", email: null };

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
const done = () => events.find((event) => event["type"] === "done");
const warnings = () => events.filter((event) => event["type"] === "warning");

beforeEach(async () => {
  events = [];
  createCf.mockClear();
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-email-none-"));
  dirs.push(dir);
  return dir;
}

/** An app's directory: its real everyapp.config.ts, and what the fake build needs. */
function appDir(manifest: EveryAppCliManifest): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-email-app-"));
  dirs.push(dir);
  writeManifest(dir, manifest);
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

function writeManifest(dir: string, manifest: EveryAppCliManifest): void {
  fs.writeFileSync(
    path.join(dir, "everyapp.config.ts"),
    `export default ${JSON.stringify(manifest, null, 2)} as const;\n`,
  );
}

/** A manifest beside the app's, for `--manifest`: jiti caches a path once loaded in this process. */
function droppedManifest(dir: string, manifest: EveryAppCliManifest): string {
  const file = path.join(dir, "dropped.config.ts");
  fs.writeFileSync(file, `export default ${JSON.stringify(manifest, null, 2)} as const;\n`);
  return file;
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
    interactive: false,
  });
  events = [];
  account.cf.calls.length = 0;
  return (await readApp(db(), manifest.id)).workerName;
}

/** The app registered, its Worker not uploaded yet (`pending`). */
async function registerOnly(manifest: EveryAppCliManifest): Promise<string> {
  const { plan } = await register(db(), {
    appSlug: manifest.id,
    name: manifest.id,
    description: manifest.id,
    manifest,
    appBaseDomain: "example.com",
    deployer: DEPLOYER,
    organizationName: "Acme",
  });
  return plan.app.workerName!;
}

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

const createCf = vi.fn(() => account.cf);

type SetOptions = Omit<Parameters<typeof setEmail>[0], "flags" | "out" | "cwd" | "createCf">;
function set(cwd: string, options: SetOptions & { flags?: Record<string, unknown> } = {}) {
  const { flags: extra, ...rest } = options;
  return setEmail({ flags: { ...flags, ...extra }, out: out(), cwd, createCf, ...rest });
}
function unset(cwd: string, options: { senders?: boolean; inbound?: boolean } = {}) {
  return unsetEmail({ flags, out: out(), cwd, createCf, ...options });
}
function show(cwd: string) {
  return showEmail({ flags, out: out(), cwd, createCf });
}

/** The app's row, as the Gateway holds it. */
const row = (appSlug = "inbox") =>
  account
    .database(GATEWAY)
    .all("SELECT email_senders, email_inbound FROM apps WHERE app_slug = ?", appSlug)[0] as {
    email_senders: string | null;
    email_inbound: string | null;
  };
const routes = async (workerName = WORKER) =>
  (await readOwnedResources(db(), workerName)).filter((resource) => resource.kind === "email-route");
const cfCalls = (command: string) => account.cf.calls.filter((call) => call.args[0] === command);

describe("email set stores the lists on the Gateway and routes the addresses at once", () => {
  it("sets the senders and says what the app sends as", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    await set(dir, { senders: SENDERS });

    expect(done()).toMatchObject({
      message: "inbox sends as *@example.com, ceo@example.com.",
      data: {
        app: { id: "inbox", workerName: WORKER, status: "active" },
        senders: { value: SENDERS, changed: true },
        inbound: { value: [], changed: false, routed: [], removed: [] },
      },
    });
    expect(done()!["data"]["next"]).toBeUndefined();
    expect(row()).toEqual({ email_senders: JSON.stringify(SENDERS), email_inbound: null });
    expect(cfCalls("email-routing")).toEqual([]);
    expect((await readApp(db(), "inbox")).email).toEqual({ senders: SENDERS, inbound: [] });
  });

  it("routes the inbound addresses the moment they are set, recording each", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    await set(dir, { inbound: INBOUND });

    expect(done()).toMatchObject({
      message: `Mail to *@example.com, support@mail.example.com goes to ${WORKER}. To reply from example.com, mail.example.com, onboard them to Email Sending and list them with \`pnpm everyapp email set --sender\` (docs/runbooks/email-sending-setup.md).`,
      data: {
        senders: { value: [], changed: false },
        inbound: { value: INBOUND, changed: true, routed: INBOUND, removed: [] },
      },
    });
    expect(row()).toEqual({ email_senders: null, email_inbound: JSON.stringify(INBOUND) });
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
      actions: [{ type: "worker", value: [WORKER] }],
    });
    expect(await routes()).toEqual([
      expect.objectContaining({ binding: "*@example.com", resourceId: "catch_all:zone-1" }),
      expect.objectContaining({
        binding: "support@mail.example.com",
        resourceId: `zone-1/${support!.id}`,
      }),
    ]);
    // Nothing built or uploaded.
    expect(cfCalls("deploy")).toEqual([]);
    expect(cfCalls("build")).toEqual([]);
  });

  it("replaces one list and keeps the other", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS });
    events = [];

    await set(dir, { inbound: INBOUND });
    expect(row()).toEqual({
      email_senders: JSON.stringify(SENDERS),
      email_inbound: JSON.stringify(INBOUND),
    });
    // The senders cover example.com, not mail.example.com.
    expect(done()!["message"]).toBe(
      `Mail to *@example.com, support@mail.example.com goes to ${WORKER}. To reply from mail.example.com, onboard it to Email Sending and list it with \`pnpm everyapp email set --sender\` (docs/runbooks/email-sending-setup.md).`,
    );

    events = [];
    await set(dir, { senders: ["*@mail.example.com"] });
    expect(done()!["message"]).toBe("inbox sends as *@mail.example.com.");
    expect(row()).toEqual({
      email_senders: '["*@mail.example.com"]',
      email_inbound: JSON.stringify(INBOUND),
    });
    expect(await routes()).toHaveLength(2);
  });

  it("removes the routes an address list drops, in the same run", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { inbound: INBOUND });
    events = [];

    await set(dir, { inbound: ["*@example.com"] });

    expect(done()).toMatchObject({
      message: `Mail to *@example.com goes to ${WORKER}. Removed the routes for support@mail.example.com. To reply from example.com, onboard it to Email Sending and list it with \`pnpm everyapp email set --sender\` (docs/runbooks/email-sending-setup.md).`,
      data: {
        inbound: {
          value: ["*@example.com"],
          changed: true,
          routed: ["*@example.com"],
          removed: ["support@mail.example.com"],
        },
      },
    });
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    expect((await routes()).map((route) => route.binding)).toEqual(["*@example.com"]);
    expect(row().email_inbound).toBe('["*@example.com"]');
  });

  it("says what is already so, and reconciles the routes anyway", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS, inbound: INBOUND });
    const [support] = account.emailRulesFor("zone-1", "support@mail.example.com");
    events = [];

    await set(dir, { senders: [...SENDERS].reverse(), inbound: [...INBOUND].reverse() });

    expect(done()).toMatchObject({
      message: `inbox already sends as ceo@example.com, *@example.com. Mail to support@mail.example.com, *@example.com already goes to ${WORKER}.`,
      data: {
        senders: { changed: false },
        inbound: { changed: false, routed: ["support@mail.example.com", "*@example.com"], removed: [] },
      },
    });
    // The same rule, adopted, not a second one.
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(1);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")[0]!.id).toBe(support!.id);
    expect(await routes()).toHaveLength(2);

    // The rule deleted by hand: the same list makes it again, and says "goes to", not "already".
    account.emailRoutingOf("zone-1").rules.delete(support!.id);
    events = [];
    await set(dir, { inbound: INBOUND });
    expect(done()!["message"]).toBe(
      `Mail to *@example.com, support@mail.example.com goes to ${WORKER}. To reply from mail.example.com, onboard it to Email Sending and list it with \`pnpm everyapp email set --sender\` (docs/runbooks/email-sending-setup.md).`,
    );
    expect(done()!["data"]["inbound"]).toMatchObject({ changed: false, routed: INBOUND });
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
  });

  it("turns routing on with --enable-email-routing, and asks at a terminal", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    const asked: string[] = [];
    await set(dir, {
      inbound: ["support@mail.example.com"],
      interactive: true,
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
    });
    expect(asked).toEqual([
      "Turn on Email Routing for mail.example.com? Cloudflare adds and locks its MX and SPF records, so mail for it goes to Cloudflare from then on.",
    ]);
    expect(
      account.dnsRecords.filter((record) => record.name === "mail.example.com" && record.type === "MX"),
    ).toHaveLength(3);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
    expect(row().email_inbound).toBe('["support@mail.example.com"]');

    // Declined: nothing changes, the row included.
    events = [];
    await expect(set(dir, { inbound: INBOUND, interactive: true, confirm: async () => false })).rejects.toMatchObject({
      code: "EMAIL_ROUTING_DISABLED",
      message: expect.stringContaining("Email Routing stays off for example.com, so nothing was changed."),
    });
    expect(row().email_inbound).toBe('["support@mail.example.com"]');
    expect(account.emailRoutingOf("zone-1").enabled).toBe(false);

    // The flag says yes for the person.
    events = [];
    await set(dir, { inbound: INBOUND, enableRouting: true });
    expect(account.emailRoutingOf("zone-1").enabled).toBe(true);
    expect(await routes()).toHaveLength(2);
    expect(done()!["message"]).toContain(`Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`);
  });

  it("hints at the senders replying needs, unless they cover the domains", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    await set(dir, { inbound: INBOUND });
    expect(done()!["message"]).toContain(
      "To reply from example.com, mail.example.com, onboard them to Email Sending and list them with `pnpm everyapp email set --sender`",
    );

    events = [];
    await set(dir, { senders: ["*@example.com"], inbound: INBOUND });
    expect(done()!["message"]).toBe(
      `inbox sends as *@example.com. Mail to *@example.com, support@mail.example.com already goes to ${WORKER}.`,
    );

    events = [];
    await set(dir, { senders: ["*@example.com", "support@mail.example.com"], inbound: ["*@example.com", "help@mail.example.com"] });
    expect(done()!["message"]).toBe(
      `inbox sends as *@example.com, support@mail.example.com. Mail to *@example.com, help@mail.example.com goes to ${WORKER}. Removed the routes for support@mail.example.com.`,
    );
  });
});

describe("email set refuses before anything is read or changed", () => {
  it("a malformed or uppercase sender, too many and duplicate addresses, before the manifest is read", async () => {
    const dir = emptyDir();
    await expect(set(dir, { senders: ["bad"] })).rejects.toMatchObject({
      code: "EMAIL_SENDER_INVALID",
      message: '"bad" isn\'t a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.',
      data: { problems: ['"bad" isn\'t a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.'] },
    });
    await expect(set(dir, { senders: ["Ben@hi.openseo.so"] })).rejects.toMatchObject({
      code: "EMAIL_SENDER_INVALID",
      message: '"Ben@hi.openseo.so" isn\'t a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.',
    });
    const many = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`);
    await expect(set(dir, { inbound: many })).rejects.toMatchObject({
      code: "EMAIL_INBOUND_INVALID",
      message: "At most 50 inbound addresses, not 51.",
    });
    await expect(set(dir, { inbound: ["a@example.com", "Hi@example.com", "a@example.com"] })).rejects.toMatchObject({
      code: "EMAIL_INBOUND_INVALID",
      message:
        '"Hi@example.com" isn\'t an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase. a@example.com is listed twice.',
    });
    expect(createCf).not.toHaveBeenCalled();
  });

  it("nothing to set", async () => {
    await expect(set(emptyDir())).rejects.toMatchObject({
      code: "EMAIL_NOTHING_TO_SET",
      message: "Name what to set: --sender <pattern> and/or --inbound <address>.",
    });
    expect(createCf).not.toHaveBeenCalled();
  });

  it("a sender for an app that lists no email, and an address for one that declares no inbound", async () => {
    await expect(set(appDir(NOTES), { senders: ["*@example.com"] })).rejects.toMatchObject({
      code: "EMAIL_NOT_DECLARED",
      message:
        'notes doesn\'t list email in its capabilities, so it can\'t send mail. Add capabilities: { email: { access: "write" } } to everyapp.config.ts and deploy, then set its senders.',
    });
    await expect(set(appDir(MAILER), { inbound: ["*@example.com"] })).rejects.toMatchObject({
      code: "EMAIL_INBOUND_NOT_DECLARED",
      message:
        "mailer doesn't declare email: { inbound: true } in everyapp.config.ts, so no mail is routed to it. Declare it (its Worker exports email()) and deploy, then set its addresses.",
    });
    // The manifest is read, the Gateway isn't.
    expect(createCf).not.toHaveBeenCalled();
  });

  it("an app that isn't registered", async () => {
    await expect(set(appDir(INBOX), { senders: ["*@example.com"] })).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: 'No app "inbox" is registered on this gateway; deploy it first.',
    });
  });

  it("senders on a hosted Gateway", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await db().run([{ sql: "UPDATE _everyapp_install SET deployment_mode = 'hosted'" }]);

    await expect(set(dir, { senders: ["*@example.com"], inbound: INBOUND })).rejects.toMatchObject({
      code: "EMAIL_SENDERS_HOSTED",
      message:
        "This Gateway is hosted and sends app mail from its own sender only for now; it takes no app senders. Leave --sender out.",
    });
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
    expect(await routes()).toEqual([]);

    // Inbound addresses alone are fine, and the sentence names no `email set --sender` this Gateway refuses.
    events = [];
    await set(dir, { inbound: INBOUND });
    expect(done()!["message"]).toBe(`Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`);
    expect(row().email_inbound).toBe(JSON.stringify(INBOUND));
    expect(await routes()).toHaveLength(2);
  });

  it("an address another app routes, a catch-all on a subdomain, a domain no zone holds", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    const helpdesk: EveryAppCliManifest = { id: "helpdesk", email: { inbound: true } };
    const other = appDir(helpdesk);
    await deploy(other, helpdesk);
    await set(other, { inbound: ["support@mail.example.com"] });

    await expect(set(dir, { inbound: ["support@mail.example.com"] })).rejects.toMatchObject({
      code: "EMAIL_ADDRESS_TAKEN",
      message:
        "support@mail.example.com is routed to every-acme-helpdesk: another app recorded it. Take another address, or remove it from that app first (everyapp email unset --inbound, in its directory).",
    });
    await expect(set(dir, { inbound: ["*@mail.example.com"] })).rejects.toMatchObject({
      code: "EMAIL_CATCH_ALL_NOT_APEX",
    });
    await expect(set(dir, { inbound: ["support@unknown.net"] })).rejects.toMatchObject({
      code: "EMAIL_ZONE_NOT_FOUND",
    });
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
    expect(await routes()).toEqual([]);
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(1);
  });

  it("stops unattended before anything changes when routing is off", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "email", "set", "--inbound", "*@example.com", "--json"];
    try {
      await expect(set(dir, { inbound: ["*@example.com"] })).rejects.toMatchObject({
        code: "EMAIL_ROUTING_DISABLED",
        authorize: true,
        rerun: "pnpm everyapp email set --inbound '*@example.com' --enable-email-routing",
        data: { domains: ["example.com"] },
      });
    } finally {
      process.argv = argv;
    }
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
    expect(account.emailRoutingOf("zone-1").enabled).toBe(false);
    expect(await routes()).toEqual([]);
  });

  it("a shared app's lists are the platform admins' to change", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    // A shared app, and a login that isn't an owner or admin of the platform organization.
    account.database(GATEWAY).sqlite.exec("UPDATE apps SET scope = 'shared'");

    await expect(set(dir, { senders: SENDERS })).rejects.toMatchObject({
      code: "SHARED_APP_FORBIDDEN",
      message: expect.stringContaining("dev@example.com isn't one on this gateway"),
    });
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
  });
});

describe("email set keeps the row and the routes consistent", () => {
  it("stores addresses for a registered app before its first upload, and the next deploy routes them", async () => {
    const dir = appDir(INBOX);
    expect(await registerOnly(INBOX)).toBe(WORKER);

    await set(dir, { inbound: INBOUND });

    expect(done()).toMatchObject({
      message: `Mail to *@example.com, support@mail.example.com goes to ${WORKER} once \`pnpm everyapp deploy\` uploads it.`,
      data: {
        app: { status: "pending" },
        inbound: { value: INBOUND, changed: true, routed: [], removed: [] },
        next: ["pnpm everyapp deploy"],
      },
    });
    expect(row().email_inbound).toBe(JSON.stringify(INBOUND));
    expect(cfCalls("email-routing")).toEqual([]);
    expect(await routes()).toEqual([]);

    routeMail();
    await deploy(dir, INBOX);
    expect(await routes()).toHaveLength(2);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
  });

  it("stores addresses for an app whose deployed manifest doesn't declare inbound yet, and the next deploy routes them", async () => {
    // Deployed before the declaration; everyapp.config.ts has it now, the Worker not yet.
    const undeclared: EveryAppCliManifest = { ...INBOX, email: {} };
    const dir = appDir(undeclared);
    await deploy(dir, undeclared);
    writeManifest(dir, INBOX);
    account.apps.set(dir, INBOX);

    await set(dir, { inbound: INBOUND });

    expect(done()).toMatchObject({
      message: `Mail to *@example.com, support@mail.example.com goes to ${WORKER} once \`pnpm everyapp deploy\` uploads the manifest that declares email: { inbound: true }.`,
      data: {
        app: { status: "active" },
        inbound: { value: INBOUND, changed: true, routed: [], removed: [] },
        next: ["pnpm everyapp deploy"],
      },
    });
    expect(row().email_inbound).toBe(JSON.stringify(INBOUND));
    expect(cfCalls("email-routing")).toEqual([]);
    expect(await routes()).toEqual([]);

    routeMail();
    await deploy(dir, INBOX);
    expect(await routes()).toHaveLength(2);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
  });

  it("keeps the saved addresses when a rule can't be created, and says to deploy", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    let failed = false;
    account.cf.override(["email-routing", "rules", "create"], (call) => {
      if (failed) return account["emailRoutingCommand"](call);
      failed = true;
      return { exitCode: 1, stderr: "┌ Error\n│ boom\n└\n" };
    });

    await expect(set(dir, { inbound: INBOUND })).rejects.toThrow("boom");

    expect(warnings()).toContainEqual(
      expect.objectContaining({
        code: "EMAIL_ROUTES_PARTIAL",
        step: "app.email",
        message: expect.stringMatching(
          /^Saved inbox's addresses; routing them stopped at: .+ Run `pnpm everyapp deploy` \(in inbox's directory\), or this command again, to finish\.$/,
        ),
      }),
    );
    expect(row().email_inbound).toBe(JSON.stringify(INBOUND));
    // The catch-all went first; the rule's address was claimed, its rule never made.
    expect((await routes()).map((route) => route.binding)).toEqual(INBOUND);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toEqual([]);

    // `show` counts the claim as no route, and says what to run.
    events = [];
    await show(dir);
    expect(done()).toMatchObject({
      message: expect.stringContaining("Not routed yet: support@mail.example.com."),
      data: { routed: ["*@example.com"], next: ["pnpm everyapp deploy"] },
    });

    await deploy(dir, INBOX);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
    expect((await routes()).every((route) => route.resourceId !== null)).toBe(true);
  });

  it("waits for a deploy's lease, and loses to one", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    // Another deploy holds the lease: this run waits for it.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const held = await acquireLease({ db: db(), id: `app:${WORKER}`, purpose: "app.deploy", heartbeatMs: 0 });
      const run = set(dir, { senders: SENDERS });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "progress",
            step: "app.lease",
            message: expect.stringContaining(
              `Waiting for another deploy of inbox to finish (${held.holder.split(":")[0]!.replace(/\.local$/, "")}, started`,
            ),
          }),
        ),
      );
      await held.release();
      await vi.advanceTimersByTimeAsync(5_000);
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(done()!["message"]).toBe("inbox sends as *@example.com, ceo@example.com.");

    // Lost right before the write: nothing changes.
    events = [];
    loseLeaseAtCheck(account, `app:${WORKER}`, 1);
    await expect(set(dir, { inbound: INBOUND })).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(row()).toEqual({ email_senders: JSON.stringify(SENDERS), email_inbound: null });
    expect(await routes()).toEqual([]);
  });

  it("says the addresses are saved when the lease is lost after the write, before the routes", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    // The first renewal is the check before the write, the second the one before the routes.
    loseLeaseAtCheck(account, `app:${WORKER}`, 2);

    await expect(set(dir, { inbound: INBOUND })).rejects.toMatchObject({ code: "LEASE_LOST" });

    // The row is the intent: written. The ledger: nothing yet.
    expect(row().email_inbound).toBe(JSON.stringify(INBOUND));
    expect(await routes()).toEqual([]);
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    // And the run says so, as it does when a rule can't be created.
    expect(warnings()).toContainEqual(
      expect.objectContaining({
        code: "EMAIL_ROUTES_PARTIAL",
        step: "app.email",
        message: expect.stringMatching(/^Saved inbox's addresses; routing them stopped at: .+ Run `pnpm everyapp deploy`/),
      }),
    );

    // The other deploy's lease gone, a deploy finishes from the same row.
    account.database(GATEWAY).sqlite.exec("DELETE FROM _everyapp_deploy_lease");
    await deploy(dir, INBOX);
    expect(await routes()).toHaveLength(2);
  });

  it("takes --manifest for an app whose config isn't here", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    const manifest = path.join(dir, "everyapp.config.ts");

    await expect(set(emptyDir(), { senders: SENDERS })).rejects.toThrow("No everyapp.config.ts found");
    await set(emptyDir(), { senders: SENDERS, flags: { manifest } });
    expect(done()!["message"]).toBe("inbox sends as *@example.com, ceo@example.com.");

    events = [];
    await showEmail({ flags: { ...flags, manifest }, out: out(), cwd: emptyDir(), createCf });
    expect(done()!["data"]).toMatchObject({ senders: SENDERS });
  });
});

describe("email unset", () => {
  it("clears the inbound addresses and removes their routes, keeping the senders", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS, inbound: INBOUND });
    events = [];

    await unset(dir, { inbound: true });

    expect(done()).toMatchObject({
      message: "inbox receives no mail. Removed the routes for *@example.com, support@mail.example.com.",
      data: {
        senders: { value: SENDERS, changed: false },
        inbound: { value: [], changed: true, routed: [], removed: INBOUND },
      },
    });
    expect(row()).toEqual({ email_senders: JSON.stringify(SENDERS), email_inbound: null });
    expect(await routes()).toEqual([]);
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);
    expect(account.emailRoutingOf("zone-1").catchAll).toMatchObject({ enabled: false, actions: [{ type: "drop" }] });
  });

  it("clears the senders", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS });
    events = [];

    await unset(dir, { senders: true });

    expect(done()).toMatchObject({
      message: "inbox sends as the Gateway's sender only.",
      data: { senders: { value: [], changed: true } },
    });
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
  });

  it("says what was already clear", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    await unset(dir, { senders: true, inbound: true });

    expect(done()).toMatchObject({
      message: "inbox already sends as the Gateway's sender only. inbox already receives no mail.",
      data: { senders: { changed: false }, inbound: { changed: false } },
    });
    expect(cfCalls("email-routing")).toEqual([]);
  });

  it("clears a side the manifest no longer declares", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS, inbound: INBOUND });
    // The declarations dropped, in a file of its own: the one `set` loaded
    // stays cached in this process, so rewriting it would prove nothing.
    const dropped = droppedManifest(dir, { id: "inbox" });
    events = [];

    await unsetEmail({ flags: { ...flags, manifest: dropped }, out: out(), cwd: emptyDir(), createCf, senders: true, inbound: true });

    expect(done()!["message"]).toBe(
      "inbox sends as the Gateway's sender only. inbox receives no mail. Removed the routes for *@example.com, support@mail.example.com.",
    );
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
    expect(await routes()).toEqual([]);

    // That manifest was the one read: it declares neither.
    events = [];
    await showEmail({ flags: { ...flags, manifest: dropped }, out: out(), cwd: emptyDir(), createCf });
    expect(done()!["data"]["declares"]).toEqual({ sends: false, receives: false });
  });

  it("refuses with nothing named", async () => {
    await expect(unset(emptyDir())).rejects.toMatchObject({
      code: "EMAIL_NOTHING_TO_UNSET",
      message: "Name what to clear: --senders and/or --inbound.",
    });
    expect(createCf).not.toHaveBeenCalled();
  });
});

describe("email show", () => {
  it("prints both lists against what the manifest declares, and the Worker", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS, inbound: INBOUND });
    events = [];
    account.cf.calls.length = 0;

    await show(dir);

    expect(done()).toEqual(
      expect.objectContaining({
        message: ["inbox sends as *@example.com, ceo@example.com.", `Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`].join("\n"),
        data: {
          app: { id: "inbox", workerName: WORKER, status: "active", deployed: true },
          declares: { sends: true, receives: true },
          senders: SENDERS,
          inbound: INBOUND,
          routed: INBOUND,
        },
      }),
    );
    expect(cfCalls("email-routing")).toEqual([]);
  });

  it("says an app sends as the Gateway's sender only and receives no mail", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    await show(dir);

    expect(done()).toMatchObject({
      message: "inbox sends as the Gateway's sender only.\ninbox receives no mail.",
      data: { senders: [], inbound: [], routed: [] },
    });
    expect(done()!["data"]["next"]).toBeUndefined();
  });

  it("says what the manifest doesn't declare", async () => {
    const dir = appDir(NOTES);
    await deploy(dir, NOTES);

    await show(dir);

    expect(done()).toMatchObject({
      message:
        "notes doesn't list email in its capabilities, so it doesn't send mail.\nnotes doesn't declare email: { inbound: true }, so no mail is routed to it.",
      data: { declares: { sends: false, receives: false } },
    });
  });

  it("before the first deploy, says so and exits 0", async () => {
    const sink = out();
    await showEmail({ flags, out: sink, cwd: appDir(INBOX), createCf });

    expect(done()).toEqual(
      expect.objectContaining({
        message: "inbox isn't deployed yet; its senders and addresses are set after its first `pnpm everyapp deploy`.",
        data: { app: { id: "inbox", deployed: false }, declares: { sends: true, receives: true } },
      }),
    );
    expect(sink.exitCode).toBe(0);
  });

  it("names an address set but not routed, with deploy as the next command", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { inbound: INBOUND });
    // A ledger row gone, say (a reconcile that stopped before its rule leaves a claim, counted as no route above).
    account
      .database(GATEWAY)
      .sqlite.prepare("DELETE FROM _everyapp_app_resources WHERE kind = 'email-route' AND binding = ?")
      .run("support@mail.example.com");
    events = [];

    await show(dir);

    expect(done()).toMatchObject({
      message: [
        "inbox sends as the Gateway's sender only.",
        `Mail to *@example.com, support@mail.example.com goes to ${WORKER}.`,
        "Not routed yet: support@mail.example.com.",
      ].join("\n"),
      data: { inbound: INBOUND, routed: ["*@example.com"], next: ["pnpm everyapp deploy"] },
    });

    // The other way round: a route the list no longer names.
    account
      .database(GATEWAY)
      .sqlite.prepare("UPDATE apps SET email_inbound = ? WHERE app_slug = 'inbox'")
      .run('["support@mail.example.com"]');
    events = [];
    await show(dir);
    expect(done()!["message"]).toContain("Not routed yet: support@mail.example.com.\nStill routed, no longer listed: *@example.com.");
  });

  it("shows the addresses set before the first upload, with deploy as the next command", async () => {
    const dir = appDir(INBOX);
    await registerOnly(INBOX);
    await set(dir, { inbound: INBOUND });
    events = [];

    await show(dir);

    expect(done()).toMatchObject({
      message: [
        "inbox sends as the Gateway's sender only.",
        `Mail to *@example.com, support@mail.example.com goes to ${WORKER} once \`pnpm everyapp deploy\` uploads it.`,
      ].join("\n"),
      data: {
        app: { id: "inbox", workerName: WORKER, status: "pending", deployed: false },
        inbound: INBOUND,
        routed: [],
        next: ["pnpm everyapp deploy"],
      },
    });
    expect(done()!["message"]).not.toContain("Not routed yet");
  });

  it("names the clearing command, not a deploy, for addresses stored under a dropped declaration", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { inbound: INBOUND });
    // The manifest drops the declaration and is deployed: routes removed, the list kept.
    const undeclared: EveryAppCliManifest = { ...INBOX, email: {} };
    await deploy(dir, undeclared);
    const dropped = droppedManifest(dir, undeclared);
    events = [];

    await showEmail({ flags: { ...flags, manifest: dropped }, out: out(), cwd: emptyDir(), createCf });

    expect(done()).toMatchObject({
      message: [
        "inbox sends as the Gateway's sender only.",
        "inbox doesn't declare email: { inbound: true }, so no mail is routed to it.",
        "Its addresses (*@example.com, support@mail.example.com) stay stored until `pnpm everyapp email unset --inbound` clears them.",
      ].join("\n"),
      data: { declares: { sends: true, receives: false }, inbound: INBOUND, routed: [] },
    });
    expect(done()!["data"]["next"]).toBeUndefined();
  });
});
