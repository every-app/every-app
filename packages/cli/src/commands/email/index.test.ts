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
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { LeasePurpose } from "@/lib/gateway/lease";
import { holdLease } from "@/test/holdLease";
import { readApp, register, type Deployer } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createHumanSink, createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { loseLeaseAtCheck } from "@/test/loseLease";
import { deployApp } from "../deploy/deployApp";
import { EmailList } from "./command";
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
function unset(cwd: string, ...lists: EmailList[]) {
  return unsetEmail({ flags, out: out(), cwd, createCf, lists });
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
      message: "inbox sends as *@example.com, ceo@example.com. The Gateway picks up the change within 30 seconds.",
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
      message: "Mail to *@example.com, support@mail.example.com goes to inbox.",
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
    expect(done()!["message"]).toBe("Mail to *@example.com, support@mail.example.com goes to inbox.");

    events = [];
    await set(dir, { senders: ["*@mail.example.com"] });
    expect(done()!["message"]).toBe(
      "inbox sends as *@mail.example.com. The Gateway picks up the change within 30 seconds.",
    );
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
      message: "Mail to *@example.com goes to inbox. Stopped routing support@mail.example.com.",
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
      message: "inbox already sends as ceo@example.com, *@example.com. Mail to support@mail.example.com, *@example.com already goes to inbox.",
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
    expect(done()!["message"]).toBe("Mail to *@example.com, support@mail.example.com goes to inbox.");
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
      "Turn on Email Routing for mail.example.com?",
    ]);
    expect(
      account.dnsRecords.filter((record) => record.name === "mail.example.com" && record.type === "MX"),
    ).toHaveLength(3);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toHaveLength(1);
    expect(row().email_inbound).toBe('["support@mail.example.com"]');

    // Declined: nothing changes, the row included.
    events = [];
    await expect(set(dir, { inbound: INBOUND, interactive: true, confirm: async () => false })).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Cancelled. Nothing changed.",
    });
    expect(row().email_inbound).toBe('["support@mail.example.com"]');
    expect(account.emailRoutingOf("zone-1").enabled).toBe(false);

    // The flag says yes for the person.
    events = [];
    await set(dir, { inbound: INBOUND, enableRouting: true });
    expect(account.emailRoutingOf("zone-1").enabled).toBe(true);
    expect(await routes()).toHaveLength(2);
    expect(done()!["message"]).toBe("Mail to *@example.com, support@mail.example.com goes to inbox.");
  });

  it("says what changed a line each, and how to reply from a domain no sender covers", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    const shown = async (options: Omit<SetOptions, "flags">) => {
      let text = "";
      await setEmail({
        flags: {},
        out: createHumanSink({ write: (line) => void (text += line), writeProblem: () => undefined }),
        cwd: dir,
        createCf,
        ...options,
      });
      return stripVTControlCharacters(text);
    };

    expect(await shown({ senders: ["ceo@example.com"], inbound: INBOUND })).toBe(
      [
        "inbox sends as ceo@example.com ✓",
        "Mail to *@example.com, support@mail.example.com goes to inbox ✓",
        "The Gateway picks up the change within 30 seconds.",
        "",
        // ceo@example.com covers example.com.
        "To reply from mail.example.com, set it up for Email Sending, then:",
        "  pnpm everyapp email set --sender 'ceo@example.com' --sender '*@mail.example.com'",
        "",
      ].join("\n"),
    );
    expect(
      await shown({ senders: ["*@example.com", "support@mail.example.com"], inbound: ["*@example.com", "help@mail.example.com"] }),
    ).toBe(
      [
        "inbox sends as *@example.com, support@mail.example.com ✓",
        "Mail to *@example.com, help@mail.example.com goes to inbox ✓",
        "Stopped routing support@mail.example.com ✓",
        "The Gateway picks up the change within 30 seconds.",
        "",
      ].join("\n"),
    );
    expect(await shown({ senders: ["*@example.com", "support@mail.example.com"] })).toBe(
      "Nothing changed. inbox already sends as *@example.com, support@mail.example.com.\n",
    );
  });
});

describe("email set refuses before anything is read or changed", () => {
  it("a malformed or uppercase sender, too many and duplicate addresses, before the manifest is read", async () => {
    const dir = emptyDir();
    await expect(set(dir, { senders: ["bad"] })).rejects.toMatchObject({
      code: "EMAIL_SENDER_INVALID",
      message: '"bad" isn\'t a sender\nA sender is "*@<domain>" or "<local>@<domain>", in lowercase.',
      data: { problems: ['"bad" isn\'t a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.'] },
    });
    // Only the case is wrong: the command again, lowercased.
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "email", "set", "--sender", "Ben@hi.openseo.so"];
    try {
      await expect(set(dir, { senders: ["Ben@hi.openseo.so"] })).rejects.toMatchObject({
        code: "EMAIL_SENDER_INVALID",
        message: '"Ben@hi.openseo.so" isn\'t a sender\nA sender is "*@<domain>" or "<local>@<domain>", in lowercase.',
        rerun: "pnpm everyapp email set --sender ben@hi.openseo.so",
      });
    } finally {
      process.argv = argv;
    }
    const many = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`);
    await expect(set(dir, { inbound: many })).rejects.toMatchObject({
      code: "EMAIL_INBOUND_INVALID",
      message: "At most 50 inbound addresses, not 51.",
    });
    await expect(set(dir, { inbound: ["a@example.com", "Hi@example.com", "a@example.com"] })).rejects.toMatchObject({
      code: "EMAIL_INBOUND_INVALID",
      message:
        '2 problems with --inbound\n• "Hi@example.com" isn\'t an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.\n• a@example.com is listed twice.',
      data: { problems: [expect.stringContaining("Hi@example.com"), "a@example.com is listed twice."] },
    });
    // The same problem twice is said once.
    await expect(set(dir, { inbound: ["support@", "support@"] })).rejects.toMatchObject({
      message: '2 problems with --inbound\n• "support@" isn\'t an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.\n• support@ is listed twice.',
    });
    expect(createCf).not.toHaveBeenCalled();
  });

  it("nothing to set", async () => {
    await expect(set(emptyDir())).rejects.toMatchObject({
      code: "EMAIL_NOTHING_TO_SET",
      message: "Name what to set: --sender, --inbound, or both",
      rerun: "pnpm everyapp email set --help",
    });
    expect(createCf).not.toHaveBeenCalled();
  });

  it("a sender for an app that lists no email, and an address for one that declares no inbound", async () => {
    await expect(set(appDir(NOTES), { senders: ["*@example.com"] })).rejects.toMatchObject({
      code: "EMAIL_NOT_DECLARED",
      message: "notes can't send mail yet\neveryapp.config.ts doesn't list email in its capabilities.",
      fix: 'add capabilities: { email: { access: "write" } } to everyapp.config.ts',
      rerun: "pnpm everyapp deploy",
      rerunNote: "then this command again",
    });
    await expect(set(appDir(MAILER), { inbound: ["*@example.com"] })).rejects.toMatchObject({
      code: "EMAIL_INBOUND_NOT_DECLARED",
      message: "mailer can't receive mail yet\neveryapp.config.ts doesn't declare email: { inbound: true }.",
      fix: "declare email: { inbound: true } and export email() from the app's Worker",
    });
    // The manifest is read, the Gateway isn't.
    expect(createCf).not.toHaveBeenCalled();
  });

  it("an app that isn't registered", async () => {
    await expect(set(appDir(INBOX), { senders: ["*@example.com"] })).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: "inbox isn't deployed to this Gateway yet",
    });
  });

  it("senders on a hosted Gateway", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await db().run([{ sql: "UPDATE _everyapp_install SET deployment_mode = 'hosted'" }]);

    await expect(set(dir, { senders: ["*@example.com"], inbound: INBOUND })).rejects.toMatchObject({
      code: "EMAIL_SENDERS_HOSTED",
      message: "This Gateway doesn't take app senders\nHosted Gateways send all app mail from their own sender for now.",
      rerun: undefined,
    });
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
    expect(await routes()).toEqual([]);

    // Inbound addresses alone are fine.
    events = [];
    await set(dir, { inbound: INBOUND });
    expect(done()!["message"]).toBe("Mail to *@example.com, support@mail.example.com goes to inbox.");
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
      message: "support@mail.example.com already goes to another app (helpdesk)",
      fix: "pick another address, or run pnpm everyapp email unset inbound in helpdesk's directory first",
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
      message: expect.stringContaining("dev@example.com isn't an owner or admin of"),
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
      message: "Saved *@example.com, support@mail.example.com. It's routed to inbox on the next deploy.",
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
      message: "Saved *@example.com, support@mail.example.com. It's routed to inbox on the next deploy.",
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

    await expect(set(dir, { inbound: INBOUND })).rejects.toMatchObject({
      code: "EMAIL_ROUTES_PARTIAL",
      message: expect.stringMatching(/^Inbound addresses saved, but routing them stopped part-way\n[\s\S]*boom/),
      retryable: true,
      rerunNote: "again, or pnpm everyapp deploy, to finish",
      data: { saved: INBOUND },
    });
    expect(row().email_inbound).toBe(JSON.stringify(INBOUND));
    // The catch-all went first; the rule's address was claimed, its rule never made.
    expect((await routes()).map((route) => route.binding)).toEqual(INBOUND);
    expect(account.emailRulesFor("zone-1", "support@mail.example.com")).toEqual([]);

    // `show` counts the claim as no route, and says what to run.
    events = [];
    await show(dir);
    expect(done()).toMatchObject({
      message: expect.stringContaining("support@mail.example.com  inbound  not routed yet"),
      data: {
        routed: ["*@example.com"],
        next: [
          { command: "pnpm everyapp deploy", note: "route the list as shown" },
          { command: "pnpm everyapp email set --sender '*@<domain>'", note: "send as your own domain" },
        ],
      },
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
      const held = await holdLease(db(), `app:${WORKER}`, LeasePurpose.AppDeploy, "inbox");
      const run = set(dir, { senders: SENDERS });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "progress",
            step: "app.lease",
            message: expect.stringContaining(
              `Waiting for a deploy of inbox to finish (dev@example.com on ${held.holder.split(":")[0]!.split(".")[0]}, started`,
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
    expect(done()!["message"]).toBe(
      "inbox sends as *@example.com, ceo@example.com. The Gateway picks up the change within 30 seconds.",
    );

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

    // The row is the intent: written, and the run says so. The ledger: nothing yet.
    await expect(set(dir, { inbound: INBOUND })).rejects.toMatchObject({
      code: "EMAIL_ROUTES_PARTIAL",
      data: { cause: "LEASE_LOST" },
    });
    expect(row().email_inbound).toBe(JSON.stringify(INBOUND));
    expect(await routes()).toEqual([]);
    expect(account.emailRoutingOf("zone-1").rules.size).toBe(0);

    // The other deploy's lease gone, a deploy finishes from the same row.
    account.database(GATEWAY).sqlite.exec("DELETE FROM _everyapp_deploy_lease");
    await deploy(dir, INBOX);
    expect(await routes()).toHaveLength(2);
  });

  it("takes --manifest for an app whose config isn't here", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    const manifest = path.join(dir, "everyapp.config.ts");

    await expect(set(emptyDir(), { senders: SENDERS })).rejects.toMatchObject({ code: "MANIFEST_NOT_FOUND" });
    await set(emptyDir(), { senders: SENDERS, flags: { manifest } });
    expect(done()!["message"]).toMatch(/^inbox sends as \*@example\.com, ceo@example\.com\./);

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

    await unset(dir, EmailList.Inbound);

    expect(done()).toMatchObject({
      message: "Stopped routing *@example.com, support@mail.example.com.",
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

    await unset(dir, EmailList.Senders);

    expect(done()).toMatchObject({
      message: "Senders cleared (sends as the Gateway's sender). The Gateway picks up the change within 30 seconds.",
      data: { senders: { value: [], changed: true } },
    });
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
  });

  it("says what was already clear", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    await unset(dir, EmailList.Senders, EmailList.Inbound);

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

    await unsetEmail({ flags: { ...flags, manifest: dropped }, out: out(), cwd: emptyDir(), createCf, lists: [EmailList.Senders, EmailList.Inbound] });

    expect(done()!["message"]).toBe(
      "Senders cleared (sends as the Gateway's sender). Stopped routing *@example.com, support@mail.example.com. The Gateway picks up the change within 30 seconds.",
    );
    expect(row()).toEqual({ email_senders: null, email_inbound: null });
    expect(await routes()).toEqual([]);

    // That manifest was the one read: it declares neither.
    events = [];
    await showEmail({ flags: { ...flags, manifest: dropped }, out: out(), cwd: emptyDir(), createCf });
    expect(done()!["data"]["declares"]).toEqual({ sends: false, receives: false });
  });
});

/** `email show`'s table as --json's message has it: a header, then a row per address. */
function table(rows: string[][]): string {
  const all = [["ADDRESS", "ROLE", "STATUS"], ...rows];
  const widths = [0, 1].map((column) => Math.max(...all.map((row) => row[column]!.length)));
  return all.map(([address, role, status]) => `${address!.padEnd(widths[0]!)}  ${role!.padEnd(widths[1]!)}  ${status}`).join("\n");
}

describe("email show", () => {
  it("lists each address with its role and status, as a table", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS, inbound: INBOUND });
    events = [];
    account.cf.calls.length = 0;

    await show(dir);

    expect(done()).toEqual(
      expect.objectContaining({
        message: table([
          ["*@example.com", "sender", "allowed"],
          ["ceo@example.com", "sender", "allowed"],
          ["*@example.com", "inbound", "routed"],
          ["support@mail.example.com", "inbound", "routed"],
        ]),
        data: {
          app: { id: "inbox", workerName: WORKER, status: "active", deployed: true },
          declares: { sends: true, receives: true },
          senders: SENDERS,
          inbound: INBOUND,
          routed: INBOUND,
          durationMs: expect.any(Number),
        },
      }),
    );
    expect(cfCalls("email-routing")).toEqual([]);
  });

  it("says an app sends as the Gateway's sender and receives no mail, and how to change that", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);

    await show(dir);

    expect(done()).toMatchObject({
      message: "inbox sends as the Gateway's sender and receives no mail.",
      data: {
        senders: [],
        inbound: [],
        routed: [],
        next: [
          { command: "pnpm everyapp email set --sender '*@<domain>'", note: "send as your own domain" },
          { command: "pnpm everyapp email set --inbound <address>", note: "receive mail" },
        ],
      },
    });
  });

  it("says how to turn each direction on for an app that declares neither", async () => {
    const dir = appDir(NOTES);
    await deploy(dir, NOTES);

    await show(dir);

    expect(done()).toMatchObject({
      message: [
        "notes doesn't send or receive email.",
        'To send, add capabilities: { email: { access: "write" } } to everyapp.config.ts.',
        "To receive, add email: { inbound: true } to everyapp.config.ts.",
      ].join("\n"),
      data: { declares: { sends: false, receives: false } },
    });
  });

  it("before the first deploy, says so and exits 0", async () => {
    const sink = out();
    await showEmail({ flags, out: sink, cwd: appDir(INBOX), createCf });

    expect(done()).toEqual(
      expect.objectContaining({
        message: "inbox isn't deployed yet. Senders and inbound addresses can be set after its first deploy.",
        data: {
          app: { id: "inbox", deployed: false },
          declares: { sends: true, receives: true },
          next: ["pnpm everyapp deploy"],
          durationMs: expect.any(Number),
        },
      }),
    );
    expect(sink.exitCode).toBe(0);
  });

  it("marks an address set but not routed, and one routed but no longer listed, with deploy as the next command", async () => {
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
        table([
          ["*@example.com", "inbound", "routed"],
          ["support@mail.example.com", "inbound", "not routed yet"],
        ]),
        "",
        "inbox sends as the Gateway's sender only.",
      ].join("\n"),
      data: {
        inbound: INBOUND,
        routed: ["*@example.com"],
        next: [
          { command: "pnpm everyapp deploy", note: "route the list as shown" },
          { command: "pnpm everyapp email set --sender '*@<domain>'", note: "send as your own domain" },
        ],
      },
    });

    // The other way round: a route the list no longer names.
    account
      .database(GATEWAY)
      .sqlite.prepare("UPDATE apps SET email_inbound = ? WHERE app_slug = 'inbox'")
      .run('["support@mail.example.com"]');
    events = [];
    await show(dir);
    expect(done()!["message"]).toContain(
      table([
        ["support@mail.example.com", "inbound", "not routed yet"],
        ["*@example.com", "inbound", "removed, still routed"],
      ]),
    );
  });

  it("shows the addresses set before the first upload, with deploy as the next command", async () => {
    const dir = appDir(INBOX);
    await registerOnly(INBOX);
    await set(dir, { inbound: INBOUND });
    events = [];

    await show(dir);

    expect(done()).toMatchObject({
      message: expect.stringContaining(
        table([
          ["*@example.com", "inbound", "not routed yet"],
          ["support@mail.example.com", "inbound", "not routed yet"],
        ]),
      ),
      data: {
        app: { id: "inbox", workerName: WORKER, status: "pending", deployed: false },
        inbound: INBOUND,
        routed: [],
        next: [
          { command: "pnpm everyapp deploy", note: "route the list as shown" },
          { command: "pnpm everyapp email set --sender '*@<domain>'", note: "send as your own domain" },
        ],
      },
    });
  });

  it("offers the side the manifest declares with nothing stored for it yet, after the list's own fix", async () => {
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await set(dir, { senders: SENDERS });
    events = [];

    await show(dir);

    expect(done()).toMatchObject({
      message: table([
        ["*@example.com", "sender", "allowed"],
        ["ceo@example.com", "sender", "allowed"],
      ]),
      data: {
        senders: SENDERS,
        inbound: [],
        next: [{ command: "pnpm everyapp email set --inbound <address>", note: "receive mail" }],
      },
    });

    // An app that only sends, with its senders set, has nothing left to set.
    const mailer = appDir(MAILER);
    await deploy(mailer, MAILER);
    await set(mailer, { senders: ["*@example.com"] });
    events = [];
    await show(mailer);
    expect(done()!["data"]["next"]).toBeUndefined();
  });

  it("names no sender command on a hosted Gateway, which takes none", async () => {
    routeMail();
    const dir = appDir(INBOX);
    await deploy(dir, INBOX);
    await db().run([{ sql: "UPDATE _everyapp_install SET deployment_mode = 'hosted'" }]);

    // Nothing stored: only the inbound side is the installation's to set there.
    await show(dir);
    expect(done()).toMatchObject({
      message: "inbox sends as the Gateway's sender and receives no mail.",
      data: { next: [{ command: "pnpm everyapp email set --inbound <address>", note: "receive mail" }] },
    });

    // Addresses routed and no senders: nothing left that `email set` could do here.
    await set(dir, { inbound: INBOUND });
    events = [];
    await show(dir);
    expect(done()).toMatchObject({
      message: expect.stringContaining("inbox sends as the Gateway's sender only."),
      data: { senders: [], inbound: INBOUND, routed: INBOUND },
    });
    expect(done()!["data"]["next"]).toBeUndefined();

    // An app that only sends has no next step at all.
    const mailer = appDir(MAILER);
    await deploy(mailer, MAILER);
    await show(mailer);
    expect(done()).toMatchObject({ message: "mailer sends as the Gateway's sender and doesn't receive email." });
    expect(done()!["data"]["next"]).toBeUndefined();
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
        table([
          ["*@example.com", "inbound", "not declared"],
          ["support@mail.example.com", "inbound", "not declared"],
        ]),
        "",
        "inbox sends as the Gateway's sender only.",
        "everyapp.config.ts no longer declares email: { inbound: true }, so this address isn't used.",
      ].join("\n"),
      data: {
        declares: { sends: true, receives: false },
        inbound: INBOUND,
        routed: [],
        next: [
          { command: "pnpm everyapp email unset inbound", note: "clear the stored address" },
          { command: "pnpm everyapp email set --sender '*@<domain>'", note: "send as your own domain" },
        ],
      },
    });
  });
});
