/**
 * `everyapp events …` end to end, in a fake Cloudflare account with a
 * deployed Gateway (as provider/index.test.ts): the subscriptions a person
 * adds (a webhook with a made secret or their own, mail to the admins),
 * every refusal before anything is written, the list, remove (a built-in
 * one disabled instead), enable and disable, a test ping the test settles
 * in the Gateway's place, the delivery log and a redeliver, the catalogue,
 * and a Gateway from before the event tables. Every --json line is a
 * protocol event, and no secret is ever in one but the made secret's
 * `done.data.secret`.
 */
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { EVENT_SUBSCRIPTIONS_MAX, EVENT_TYPES } from "@every-app/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { addEvents, type AddOptions } from "./add";
import { listDeliveriesOf, redeliverOne } from "./deliveries";
import { listEvents, listTypes } from "./list";
import { removeEvents, setEnabled } from "./manage";
import { testEvents, type TestOptions } from "./ping";
import { stateLabel } from "./shared";

const GATEWAY = "every-app-gateway";
const NOW = Date.parse("2026-10-25T09:00:00Z");
const URL_ = "https://hooks.example.org/everyapp";
const PROTOCOL_TYPES = new Set(["step", "progress", "warning", "action_required", "error", "done"]);

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let home: string;
let lines: string[];

const events = () => lines.map((line) => JSON.parse(line) as Record<string, any>);
const sink = (): EventSink => createNdjsonSink((line) => lines.push(line));
const createCf = vi.fn(() => account.cf);
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const sql = async (statement: string, ...params: Array<string | number | null>) =>
  (await db().run([{ sql: statement, params }]))[0] ?? [];
const gatewayWorker = () => account.workers.get(GATEWAY)!;
const done = () => events().find((event) => event["type"] === "done");
const error = () => events().find((event) => event["type"] === "error");
const warnings = (code: string) =>
  events().filter((event) => event["type"] === "warning" && event["code"] === code);
const flags = { json: true };

/** A handler's run as the CLI reports it: a failure becomes its last event. */
async function run(body: (out: EventSink) => Promise<void> | void): Promise<void> {
  const out = sink();
  try {
    await body(out);
  } catch (failure) {
    reportFailure(out, failure);
  }
}

/** Each add a second after the last, so they list in the order they were added. */
let clock = NOW;
const add = (url: string | undefined, options: Partial<AddOptions> = {}) =>
  run((out) => addEvents({ flags, out, createCf, now: () => (clock += 1_000), readStdin: async () => null, ...options }, url));

beforeEach(async () => {
  lines = [];
  clock = NOW;
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: sink(),
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
    sleep: async () => undefined,
    leaseWaitMs: 0,
  });
  await sql("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', ?)", NOW);
  lines = [];
});

afterEach(async () => {
  // Every line the commands wrote is a protocol event.
  for (const line of lines) {
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event["v"]).toBe(1);
    expect(typeof event["ts"]).toBe("string");
    expect(PROTOCOL_TYPES.has(String(event["type"]))).toBe(true);
  }
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const subscriptions = () =>
  sql("SELECT id, organization_id, name, sink, url, secret, recipients, events, enabled, builtin, created_by FROM event_subscriptions ORDER BY created_at, id");

describe("events add, a webhook", () => {
  it("makes a whsec_ secret, shows it once in done.data.secret, and never in a message", async () => {
    await add(URL_, { flags: { json: true, events: ["cap.*,member.*", "app.crm.*"] } });

    expect(error()).toBeUndefined();
    const [row] = await subscriptions();
    expect(row).toMatchObject({
      organization_id: "org-1",
      name: "hooks.example.org",
      sink: "webhook",
      url: URL_,
      recipients: null,
      events: JSON.stringify(["cap.*", "member.*", "app.crm.*"]),
      enabled: 1,
      builtin: null,
      created_by: "operator:dev@example.com",
    });
    const secret = String(row!["secret"]);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(done()).toMatchObject({
      message: expect.stringContaining(`Added hooks.example.org (${row!["id"]}) for Acme.`),
      data: {
        secret,
        secretGenerated: true,
        subscription: { id: row!["id"], sink: "webhook", target: "hooks.example.org/everyapp", events: ["cap.*", "member.*", "app.crm.*"] },
        organization: { id: "org-1", name: "Acme", slug: "acme" },
        next: [{ command: `pnpm everyapp events test ${row!["id"]}`, note: expect.any(String) }],
      },
    });
    // The one place it may be: done.data.secret. Never a message or another event.
    const elsewhere = events().map((event) =>
      event["type"] === "done" ? { ...event, data: { ...event["data"], secret: undefined } } : event,
    );
    expect(JSON.stringify(elsewhere)).not.toContain(secret);
  });

  it("takes the person's secret piped in, keeps it, and never echoes it", async () => {
    await add(URL_, {
      flags: { json: true, secret: true, name: "  Slack   #ops " },
      readStdin: async () => "piped-signing-secret-0123\n",
    });

    expect(error()).toBeUndefined();
    const [row] = await subscriptions();
    expect(row).toMatchObject({ name: "Slack #ops", secret: "piped-signing-secret-0123", events: '["*"]' });
    expect(done()!["data"]).toMatchObject({ secretGenerated: false, subscription: { events: ["*"] } });
    expect(done()!["data"]["secret"]).toBeUndefined();
    expect(lines.join("\n")).not.toContain("piped-signing-secret");
  });

  it("reads --secret-from-env, and asks at a hidden prompt when a person is there", async () => {
    await add(URL_, {
      flags: { json: true, "secret-from-env": "HOOK_SECRET" },
      env: { HOOK_SECRET: "from-the-environment-42" },
    });
    await add("https://hooks.example.org/second", {
      flags: { json: false, secret: true },
      interactive: true,
      prompt: async () => "typed-at-the-prompt-42",
    });

    expect(error()).toBeUndefined();
    expect((await subscriptions()).map((row) => row["secret"])).toEqual([
      "from-the-environment-42",
      "typed-at-the-prompt-42",
    ]);
  });

  it("refuses a secret it can't read, or one that won't do, before writing anything", async () => {
    await add(URL_, { flags: { json: true, secret: true } });
    expect(error()).toMatchObject({ code: "SECRET_VALUE_REQUIRED" });
    lines = [];
    await add(URL_, { flags: { json: true, "secret-from-env": "UNSET_VARIABLE" }, env: {} });
    expect(error()).toMatchObject({ code: "SECRET_EMPTY", message: "$UNSET_VARIABLE is empty or not set" });
    for (const secret of ["too-short", "has spaces in it, so no", "x".repeat(129)]) {
      lines = [];
      await add(URL_, { flags: { json: true, secret: true }, readStdin: async () => secret });
      expect(error()).toMatchObject({ code: "EVENT_SECRET_INVALID" });
      expect(lines.join("\n")).not.toContain(secret);
    }
    expect(await subscriptions()).toEqual([]);
  });

  it("refuses a value typed after --secret as VALUE_ON_COMMAND_LINE, without showing it", async () => {
    await add("hunter2-hunter2-hunter2", { flags: { json: true, secret: true } });
    expect(error()).toMatchObject({
      code: "VALUE_ON_COMMAND_LINE",
      message: expect.stringMatching(/^--secret takes no value on the command line\n/),
    });
    expect(lines.join("\n")).not.toContain("hunter2");
    expect(await subscriptions()).toEqual([]);
  });

  it("refuses a target the Gateway won't deliver to, saying why and never repeating a password", async () => {
    const refused: Array<[string, RegExp]> = [
      ["http://hooks.example.org/x", /starts with https:\/\//],
      ["ftp://hooks.example.org/x", /not ftp:/],
      ["https://user:p4ssw0rd@hooks.example.org/x", /no user name or password/],
      ["https://hooks.example.org/x#frag", /no fragment/],
      ["https://203.0.113.9/hook", /not an IP address/],
      ["https://0x7f.1/hook", /not an IP address/],
      ["https://[::1]/hook", /not an IP address/],
      ["https://localhost/hook", /local or internal name/],
      ["https://n8n.internal/hook", /local or internal name/],
      ["https://printer.local/hook", /local or internal name/],
      ["https://n8n/hook", /local or internal name/],
      ["https://hooks.acme.corp/hook", /local or internal name/],
      ["https://n8n.lan/hook", /local or internal name/],
      ["https://example.com/hook", /Gateway's own host/],
      ["https://crm.example.com/hook", /Gateway's own host, or under its apps' domain/],
      ["not a url", /isn't a URL/],
      [`https://hooks.example.org/${"a".repeat(2050)}`, /at most 2,048 characters/],
    ];
    for (const [url, why] of refused) {
      lines = [];
      await add(url);
      expect(error(), url).toMatchObject({ code: "EVENT_TARGET_REFUSED", message: expect.stringMatching(why) });
      expect(lines.join("\n")).not.toContain("p4ssw0rd");
    }
    expect(await subscriptions()).toEqual([]);
  });

  it("lets http:, IP literals and private names through with EVENTS_ALLOW_PRIVATE_TARGETS, but never the Gateway's own hosts", async () => {
    gatewayWorker().secrets["EVENTS_ALLOW_PRIVATE_TARGETS"] = "true";
    await add("http://n8n.internal:5678/webhook/x");
    expect(error()).toBeUndefined();
    expect(done()!["data"]["subscription"]["target"]).toBe("http://n8n.internal:5678/webhook/x");
    lines = [];
    await add("http://10.0.0.5:5678/webhook");
    expect(error()).toBeUndefined();
    lines = [];
    await add("https://crm.example.com/hook");
    expect(error()).toMatchObject({ code: "EVENT_TARGET_REFUSED" });
  });

  it("refuses an event type that is no type, prefix or app pattern, naming each", async () => {
    await add(URL_, { flags: { json: true, events: ["member.joined,nope.thing", "membr.*"] } });
    expect(error()).toMatchObject({
      code: "EVENT_TYPE_UNKNOWN",
      message: expect.stringContaining("2 of --events aren't event types"),
      data: { patterns: ["nope.thing", "membr.*"], rerun: "pnpm everyapp events types" },
    });
    expect(await subscriptions()).toEqual([]);
  });

  it("refuses the 26th subscription in one organization, counted by the insert itself", async () => {
    for (let index = 0; index < EVENT_SUBSCRIPTIONS_MAX; index += 1) {
      await sql(
        "INSERT INTO event_subscriptions (id, organization_id, name, sink, events, created_at, updated_at) VALUES (?, 'org-1', 'x', 'email', '[\"*\"]', ?, ?)",
        `sub_seeded${index}`,
        NOW,
        NOW,
      );
    }
    await add(URL_);
    expect(error()).toMatchObject({ code: "EVENT_SUBSCRIPTIONS_LIMIT", message: expect.stringContaining("Acme has 25 subscriptions") });
    expect(await subscriptions()).toHaveLength(EVENT_SUBSCRIPTIONS_MAX);
  });
});

describe("events add --email", () => {
  it("adds mail to the owners and admins, with no URL or secret, and warns while the Gateway has no sender", async () => {
    await add(undefined, { flags: { json: true, email: "admins", events: ["cap.*"] } });
    expect(error()).toBeUndefined();
    expect(await subscriptions()).toEqual([
      expect.objectContaining({ name: "Email owners and admins", sink: "email", url: null, secret: null, recipients: "admins", events: '["cap.*"]' }),
    ]);
    expect(warnings("EVENT_EMAIL_NOT_CONFIGURED")).toEqual([
      expect.objectContaining({ data: { rerun: "pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME" } }),
    ]);
    expect(done()!["data"]).toMatchObject({ subscription: { target: "email → owners and admins" }, secretGenerated: false });
    expect(done()!["data"]["secret"]).toBeUndefined();

    lines = [];
    gatewayWorker().secrets["EMAIL_FROM"] = "Acme <ops@acme.test>";
    await add(undefined, { flags: { json: true, email: "owners" } });
    expect(warnings("EVENT_EMAIL_NOT_CONFIGURED")).toEqual([]);
    expect(done()!["data"]["subscription"]).toMatchObject({ name: "Email owners", target: "email → owners" });
  });

  it("refuses a URL with --email, a secret with --email, and neither", async () => {
    await add(URL_, { flags: { json: true, email: "admins" } });
    expect(error()).toMatchObject({ code: "EVENT_SINK_CONFLICT", message: expect.stringContaining("not both") });
    lines = [];
    await add(undefined, { flags: { json: true, email: "admins", secret: true } });
    expect(error()).toMatchObject({ code: "EVENT_SINK_CONFLICT", message: expect.stringContaining("no signing secret") });
    lines = [];
    await add(undefined);
    expect(error()).toMatchObject({ code: "EVENT_SINK_CONFLICT", message: expect.stringContaining("Name where events go") });
    expect(await subscriptions()).toEqual([]);
  });
});

/** A subscription of the install organization's, added by the command; its id. */
async function added(url = URL_): Promise<string> {
  await add(url);
  const id = String(done()!["data"]["subscription"]["id"]);
  lines = [];
  return id;
}

describe("events list", () => {
  it("lists each subscription with its target, events and last delivery, never a secret or a URL's query", async () => {
    await add("https://hooks.example.org/everyapp?token=query-secret-123", { flags: { json: true, events: ["member.*"] } });
    const secret = String(done()!["data"]["secret"]);
    await add(undefined, { flags: { json: true, email: "admins" } });
    lines = [];

    await run((out) => listEvents({ flags, out, createCf }));
    expect(done()).toMatchObject({
      message: "2 subscriptions in Acme (at most 25)",
      data: {
        organization: { id: "org-1" },
        max: 25,
        subscriptions: [
          { name: "hooks.example.org", sink: "webhook", target: "hooks.example.org/everyapp", events: ["member.*"], enabled: true, lastDeliveryAt: null },
          { name: "Email owners and admins", sink: "email", target: "email → owners and admins", events: ["*"] },
        ],
      },
    });
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain("query-secret-123");
  });

  it("lists another organization's with --org, and refuses one that isn't there", async () => {
    await sql("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-2', 'Beta Co', 'beta', ?)", NOW + 1);
    await add(URL_, { flags: { json: true, org: "beta" } });
    lines = [];
    await run((out) => listEvents({ flags: { json: true, org: "Beta Co" }, out, createCf }));
    expect(done()!["data"]).toMatchObject({ organization: { id: "org-2" }, subscriptions: [{ target: "hooks.example.org/everyapp" }] });
    lines = [];
    await run((out) => listEvents({ flags, out, createCf }));
    expect(done()!["data"]["subscriptions"]).toEqual([]);
    lines = [];
    await run((out) => listEvents({ flags: { json: true, org: "gamma" }, out, createCf }));
    expect(error()).toMatchObject({ code: "ORGANIZATION_NOT_FOUND", message: expect.stringContaining("acme (Acme) and beta (Beta Co)") });
  });

  it("refuses a name two organizations share, as workspace does, and takes the slug", async () => {
    await sql("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-2', 'Beta Co', 'beta', ?)", NOW + 1);
    await sql("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-3', 'beta co', 'beta-2', ?)", NOW + 2);
    await run((out) => listEvents({ flags: { json: true, org: "Beta Co" }, out, createCf }));
    expect(error()).toMatchObject({ code: "ORG_AMBIGUOUS", data: { organizations: [{ slug: "beta" }, { slug: "beta-2" }] } });
    lines = [];
    await run((out) => listEvents({ flags: { json: true, org: "beta-2" }, out, createCf }));
    expect(done()!["data"]).toMatchObject({ organization: { id: "org-3" } });
  });
});

describe("the subscription.* events (the audit log's coverage)", () => {
  const queued = async () =>
    (await sql("SELECT type, actor, data FROM events WHERE type LIKE 'subscription.%' ORDER BY rowid")).map((row) => ({
      type: row["type"],
      actor: JSON.parse(String(row["actor"])),
      data: JSON.parse(String(row["data"])),
    }));
  const OPERATOR = { kind: "operator", id: "dev@example.com", email: "dev@example.com" };

  it("subscription.created, updated, removed and redelivered, the operator as the actor, never the secret or the URL's query; a catch-all hears none of them", async () => {
    // A catch-all (*) is not told about subscriptions; one naming subscription.* is.
    await add("https://hooks.example.org/audit?key=k", { flags: { json: true, events: ["subscription.*"] } });
    const watcher = String(done()!["data"]["subscription"]["id"]);
    lines = [];
    const id = await added("https://hooks.example.org/every?token=t");
    await run((out) => setEnabled({ flags, out, createCf }, id, false));
    await run((out) => setEnabled({ flags, out, createCf }, id, false));
    await run((out) => setEnabled({ flags, out, createCf }, id, true));
    await run((out) => removeEvents({ flags, out, createCf }, id));
    const subscription = { id, name: "hooks.example.org", sink: "webhook" };
    expect(await queued()).toEqual([
      { type: "subscription.created", actor: OPERATOR, data: { subscription: { id: watcher, name: "hooks.example.org", sink: "webhook" }, events: ["subscription.*"], host: "hooks.example.org" } },
      { type: "subscription.created", actor: OPERATOR, data: { subscription, events: ["*"], host: "hooks.example.org" } },
      { type: "subscription.updated", actor: OPERATOR, data: { subscription, changed: ["enabled"], enabled: false } },
      { type: "subscription.updated", actor: OPERATOR, data: { subscription, changed: ["enabled"], enabled: true } },
      { type: "subscription.removed", actor: OPERATOR, data: { subscription, disabled: false } },
    ]);
    const stored = JSON.stringify(await queued());
    expect(stored).not.toContain("whsec_");
    expect(stored).not.toContain("key=k");
    expect(stored).not.toContain("token=t");
    // The watcher gets each (its own creation included); the catch-all got none.
    const deliveries = await sql(
      "SELECT d.subscription_id, e.type FROM event_deliveries d JOIN events e ON e.id = d.event_id WHERE e.type LIKE 'subscription.%' ORDER BY e.rowid",
    );
    expect(deliveries.map((row) => row["subscription_id"])).toEqual([watcher, watcher, watcher, watcher, watcher]);
  });

  it("a built-in subscription removed is subscription.removed with disabled true", async () => {
    await sql(
      "INSERT INTO event_subscriptions (id, organization_id, name, sink, recipients, events, builtin, created_at, updated_at) VALUES ('sub_capalerts', 'org-1', 'Cap alerts', 'email', 'admins', '[\"cap.warning\",\"cap.reached\"]', 'cap_alerts', ?, ?)",
      NOW,
      NOW,
    );
    await run((out) => removeEvents({ flags, out, createCf }, "sub_capalerts"));
    expect(await queued()).toEqual([
      { type: "subscription.removed", actor: OPERATOR, data: { subscription: { id: "sub_capalerts", name: "Cap alerts", sink: "email" }, disabled: true } },
    ]);
  });
});

describe("events remove, enable and disable", () => {
  it("removes a person's subscription, and disables a built-in one instead", async () => {
    const id = await added();
    await sql(
      "INSERT INTO event_subscriptions (id, organization_id, name, sink, recipients, events, builtin, created_at, updated_at) VALUES ('sub_capalerts', 'org-1', 'Cap alerts', 'email', 'admins', '[\"cap.warning\",\"cap.reached\"]', 'cap_alerts', ?, ?)",
      NOW,
      NOW,
    );

    await run((out) => removeEvents({ flags, out, createCf }, id));
    expect(done()).toMatchObject({ data: { id, outcome: "removed" } });
    lines = [];
    await run((out) => removeEvents({ flags, out, createCf }, "sub_capalerts"));
    expect(done()).toMatchObject({
      message: expect.stringContaining("is built in, so it was disabled instead of removed"),
      data: { id: "sub_capalerts", outcome: "disabled", subscription: { enabled: false } },
    });
    expect(await subscriptions()).toEqual([expect.objectContaining({ id: "sub_capalerts", enabled: 0 })]);

    lines = [];
    await run((out) => removeEvents({ flags, out, createCf }, id));
    expect(error()).toMatchObject({ code: "EVENT_SUBSCRIPTION_NOT_FOUND", data: { rerun: "pnpm everyapp events list" } });
  });

  it("pauses and resumes, and says when nothing changed", async () => {
    const id = await added();
    await run((out) => setEnabled({ flags, out, createCf }, id, false));
    expect(done()).toMatchObject({ data: { id, enabled: false, changed: true } });
    expect((await subscriptions())[0]).toMatchObject({ enabled: 0 });
    lines = [];
    await run((out) => setEnabled({ flags, out, createCf }, id, false));
    expect(done()).toMatchObject({ message: expect.stringContaining("disabled already"), data: { changed: false } });
    lines = [];
    await run((out) => setEnabled({ flags, out, createCf }, id, true));
    expect(done()).toMatchObject({ data: { enabled: true, changed: true } });
  });

  it("never acts on another organization's subscription", async () => {
    await sql("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-2', 'Beta Co', 'beta', ?)", NOW + 1);
    await add(URL_, { flags: { json: true, org: "beta" } });
    const theirs = String(done()!["data"]["subscription"]["id"]);
    lines = [];
    await run((out) => setEnabled({ flags, out, createCf }, theirs, false));
    expect(error()).toMatchObject({ code: "EVENT_SUBSCRIPTION_NOT_FOUND" });
    expect((await subscriptions())[0]).toMatchObject({ id: theirs, enabled: 1 });
  });
});

/** The test's stand-in for the Gateway's sweep: on the first wait, settle the one pending delivery. */
function sweepTo(settle: Record<string, string | number | null>): TestOptions["wait"] {
  return {
    intervalMs: 1,
    sleep: async () => {
      const assignments = Object.keys(settle).map((column) => `${column} = ?`).join(", ");
      await sql(`UPDATE event_deliveries SET ${assignments} WHERE status = 'pending'`, ...Object.values(settle));
    },
  };
}

describe("events test", () => {
  const test = (id: string, options: Partial<TestOptions> = {}) =>
    run((out) => testEvents({ flags, out, createCf, now: () => NOW, ...options }, id));

  it("queues a ping for that subscription alone, as the Gateway's bus writes it, and reports it delivered", async () => {
    const id = await added();
    await add("https://hooks.example.org/other");
    lines = [];
    await test(id, {
      wait: sweepTo({ status: "delivered", attempts: 1, last_status_code: 204, delivered_at: NOW + 30_000, next_attempt_at: null }),
    });

    expect(error()).toBeUndefined();
    const [event] = await sql("SELECT id, organization_id, type, version, time, actor, data, app_row_id, dedupe_key FROM events WHERE type = 'ping'");
    expect(event).toMatchObject({ organization_id: "org-1", type: "ping", version: 1, time: NOW, app_row_id: null, dedupe_key: null });
    expect(String(event!["id"])).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.parse(String(event!["actor"]))).toEqual({ kind: "operator", id: "dev@example.com", email: "dev@example.com" });
    expect(JSON.parse(String(event!["data"]))).toMatchObject({ subscription: { id, name: "hooks.example.org" } });
    const deliveries = await sql("SELECT id, event_id, subscription_id, organization_id, status FROM event_deliveries WHERE event_id = ?", String(event!["id"]));
    expect(deliveries).toEqual([
      expect.objectContaining({ event_id: event!["id"], subscription_id: id, organization_id: "org-1", status: "delivered" }),
    ]);
    expect(String(deliveries[0]!["id"])).toMatch(/^dlv_[0-9a-f]{24}$/);
    expect(done()).toMatchObject({
      message: "Delivered: hooks.example.org/everyapp answered HTTP 204.",
      data: { outcome: "delivered", subscriptionId: id, delivery: { state: "delivered", lastStatusCode: 204 } },
    });
  });

  it("reports a failed attempt with the status code and the Gateway's error, and a dead one", async () => {
    const id = await added();
    await test(id, {
      wait: sweepTo({ attempts: 1, last_status_code: 500, last_error: "status_500: upstream exploded", last_attempt_at: NOW + 1, next_attempt_at: NOW + 60_000 }),
    });
    expect(done()).toMatchObject({
      message: expect.stringContaining("answered HTTP 500 (status_500: upstream exploded). The Gateway retries it"),
      data: { outcome: "failed", delivery: { status: "pending", state: "failed", attempts: 1 } },
    });

    lines = [];
    await test(id, { wait: sweepTo({ status: "dead", attempts: 1, last_status_code: 410, last_error: "status_410: gone", next_attempt_at: null }) });
    expect(done()).toMatchObject({
      message: expect.stringContaining("It is dead: the Gateway won't try it again."),
      data: { outcome: "failed", delivery: { state: "dead" } },
    });
  });

  it("reports an email subscription's delivery as recipients mailed, never as an HTTP status", async () => {
    await add(undefined, { flags: { json: true, email: "admins" } });
    const id = String(done()!["data"]["subscription"]["id"]);
    lines = [];
    await test(id, { wait: sweepTo({ status: "delivered", attempts: 1, last_status_code: 3, delivered_at: NOW + 30_000, next_attempt_at: null }) });
    expect(done()).toMatchObject({
      message: "Delivered: email → owners and admins, 3 recipients mailed.",
      data: { outcome: "delivered", delivery: { sink: "email", lastStatusCode: 3 } },
    });
    expect(lines.join("\n")).not.toContain("HTTP 3");

    lines = [];
    await test(id, { wait: sweepTo({ status: "dead", attempts: 1, last_status_code: 0, last_error: "email_not_configured", next_attempt_at: null }) });
    expect(done()!["message"]).toContain("wasn't delivered: email → owners and admins, email_not_configured.");
  });

  it("gives up after its wait with EVENT_TEST_TIMEOUT, leaving the ping queued", async () => {
    const id = await added();
    let clock = NOW;
    await test(id, { now: () => clock, wait: { timeoutMs: 90_000, intervalMs: 30_000, sleep: async (ms) => void (clock += ms) } });
    expect(error()).toMatchObject({
      code: "EVENT_TEST_TIMEOUT",
      message: expect.stringContaining("The Gateway hasn't sent the test event in 1m 30s"),
      data: { subscriptionId: id, rerun: `pnpm everyapp events deliveries ${id}` },
    });
    expect(await sql("SELECT status, attempts FROM event_deliveries")).toEqual([{ status: "pending", attempts: 0 }]);
  });

  it("returns once queued with --no-wait, and refuses a disabled subscription", async () => {
    const id = await added();
    await test(id, { flags: { json: true, "no-wait": true } });
    expect(done()).toMatchObject({ data: { outcome: "queued", subscriptionId: id, deliveryId: expect.stringMatching(/^dlv_/) } });

    lines = [];
    await sql("UPDATE event_subscriptions SET enabled = 0");
    await test(id);
    expect(error()).toMatchObject({ code: "EVENT_SUBSCRIPTION_DISABLED", data: { rerun: `pnpm everyapp events enable ${id}` } });
  });
});

/** A delivery row of `subscription` for a seeded event. */
async function seedDelivery(id: string, subscription: string, fields: { status: string; attempts: number; created: number; error?: string }) {
  await sql(
    "INSERT INTO events (id, organization_id, type, version, time, actor, data, created_at) VALUES (?, 'org-1', 'member.joined', 1, ?, '{\"kind\":\"gateway\"}', '{}', ?)",
    `evt_${id}`,
    fields.created,
    fields.created,
  );
  await sql(
    "INSERT INTO event_deliveries (id, event_id, subscription_id, organization_id, status, attempts, next_attempt_at, last_error, created_at) VALUES (?, ?, ?, 'org-1', ?, ?, ?, ?, ?)",
    id,
    `evt_${id}`,
    subscription,
    fields.status,
    fields.attempts,
    fields.status === "pending" ? fields.created + 60_000 : null,
    fields.error ?? null,
    fields.created,
  );
}

describe("events deliveries and redeliver", () => {
  it("lists the last deliveries newest first, one subscription's, dead ones, and as many as asked", async () => {
    const id = await added();
    await seedDelivery("dlv_old", id, { status: "delivered", attempts: 1, created: NOW - 2_000 });
    await seedDelivery("dlv_dead", id, { status: "dead", attempts: 7, created: NOW - 1_000, error: "timeout" });
    await seedDelivery("dlv_new", id, { status: "pending", attempts: 2, created: NOW, error: "status_502: bad gateway" });
    await seedDelivery("dlv_expired", id, { status: "delivered", attempts: 1, created: NOW - 31 * 24 * 60 * 60 * 1000 });
    const list = (more: Record<string, unknown> = {}, subscription?: string) =>
      run((out) => listDeliveriesOf({ flags: { json: true, ...more }, out, createCf, now: () => NOW }, subscription));

    await list();
    expect(done()!["message"]).toBe("The last 3 deliveries");
    expect(done()!["data"]["deliveries"].map((delivery: { id: string; state: string }) => [delivery.id, delivery.state])).toEqual([
      ["dlv_new", "failed"],
      ["dlv_dead", "dead"],
      ["dlv_old", "delivered"],
    ]);
    expect(done()!["data"]["deliveries"][0]).toMatchObject({ type: "member.joined", subscriptionName: "hooks.example.org", attempts: 2, lastError: "status_502: bad gateway" });

    lines = [];
    await list({ dead: true }, id);
    expect(done()).toMatchObject({ message: "The last dead delivery to hooks.example.org", data: { dead: true, subscriptionId: id } });
    expect(done()!["data"]["deliveries"].map((delivery: { id: string }) => delivery.id)).toEqual(["dlv_dead"]);

    lines = [];
    await list({ limit: 1 });
    expect(done()!["data"]["deliveries"]).toHaveLength(1);

    lines = [];
    await list({}, "sub_nobody");
    expect(error()).toMatchObject({ code: "EVENT_SUBSCRIPTION_NOT_FOUND" });
  });

  it("queues a dead delivery again, due now, its attempts back to 0 as the Gateway's redeliver does, and refuses one it can't find", async () => {
    const id = await added();
    await seedDelivery("dlv_dead", id, { status: "dead", attempts: 7, created: NOW - 1_000, error: "timeout" });
    await run((out) => redeliverOne({ flags, out, createCf, now: () => NOW + 5_000 }, "dlv_dead"));
    expect(done()).toMatchObject({
      message: expect.stringContaining("Queued dlv_dead again (member.joined to hooks.example.org; it was dead after 7 attempts)."),
      data: { outcome: "queued", previousStatus: "dead", delivery: { status: "pending", attempts: 0, state: "pending" } },
    });
    expect(await sql("SELECT status, attempts, next_attempt_at, redelivered_at, claimed_until FROM event_deliveries")).toEqual([
      { status: "pending", attempts: 0, next_attempt_at: NOW + 5_000, redelivered_at: NOW + 5_000, claimed_until: null },
    ]);
    // The redeliver is itself an event, naming the delivery and what it carried; the catch-all subscription gets no delivery of it.
    expect(
      (await sql("SELECT type, actor, data FROM events WHERE type = 'subscription.redelivered'")).map((row) => ({
        type: row["type"],
        actor: JSON.parse(String(row["actor"])),
        data: JSON.parse(String(row["data"])),
      })),
    ).toEqual([
      {
        type: "subscription.redelivered",
        actor: { kind: "operator", id: "dev@example.com", email: "dev@example.com" },
        data: { subscription: { id, name: "hooks.example.org", sink: "webhook" }, delivery: { id: "dlv_dead", eventId: expect.any(String), eventType: "member.joined" } },
      },
    ]);

    lines = [];
    await run((out) => redeliverOne({ flags, out, createCf }, "dlv_nothing"));
    expect(error()).toMatchObject({ code: "EVENT_DELIVERY_NOT_FOUND", data: { rerun: "pnpm everyapp events deliveries" } });
  });

  it("labels a delivered email as recipients mailed and a webhook with its status code", () => {
    const delivery = {
      id: "dlv_x", eventId: "evt_x", type: "ping", subscriptionId: "sub_x", subscriptionName: "x",
      status: "delivered", attempts: 1, nextAttemptAt: null, claimedUntil: null, lastAttemptAt: NOW,
      lastStatusCode: 3, lastError: null, deliveredAt: NOW, redeliveredAt: null, createdAt: NOW,
    } as const;
    expect(stripVTControlCharacters(stateLabel({ ...delivery, sink: "email" }, NOW))).toBe("delivered, 3 mailed");
    expect(stripVTControlCharacters(stateLabel({ ...delivery, sink: "webhook", lastStatusCode: 204 }, NOW))).toBe("delivered 204");
  });

  it("leaves a delivered delivery alone, saying so", async () => {
    const id = await added();
    await seedDelivery("dlv_done", id, { status: "delivered", attempts: 1, created: NOW - 1_000 });
    await run((out) => redeliverOne({ flags, out, createCf, now: () => NOW }, "dlv_done"));
    expect(done()).toMatchObject({
      message: expect.stringContaining("dlv_done was already delivered (member.joined to hooks.example.org). Nothing changed."),
      data: { outcome: "delivered", previousStatus: "delivered", delivery: { status: "delivered", attempts: 1 } },
    });
    expect(await sql("SELECT status, attempts, redelivered_at FROM event_deliveries")).toEqual([
      { status: "delivered", attempts: 1, redelivered_at: null },
    ]);
  });

  it("leaves a delivery being attempted to its attempt, and refuses one whose subscription is paused", async () => {
    const id = await added();
    await seedDelivery("dlv_busy", id, { status: "pending", attempts: 1, created: NOW });
    await sql("UPDATE event_deliveries SET claimed_until = ?", NOW + 60_000);
    await run((out) => redeliverOne({ flags, out, createCf, now: () => NOW }, "dlv_busy"));
    expect(done()).toMatchObject({ data: { outcome: "attempting" }, message: expect.stringContaining("being sent right now") });

    lines = [];
    await sql("UPDATE event_subscriptions SET enabled = 0");
    await run((out) => redeliverOne({ flags, out, createCf, now: () => NOW + 120_000 }, "dlv_busy"));
    expect(error()).toMatchObject({ code: "EVENT_SUBSCRIPTION_DISABLED" });
  });
});

describe("events types", () => {
  it("lists the catalogue with versions, and the patterns, without reaching the Gateway", async () => {
    createCf.mockClear();
    await run((out) => listTypes({ out }));
    expect(done()!["data"]["types"]).toHaveLength(EVENT_TYPES.length);
    expect(done()!["data"]["types"]).toContainEqual(
      expect.objectContaining({ type: "member.joined", version: 1, group: "member" }),
    );
    expect(done()!["data"]["patterns"]).toContain("app.<app id>.*");
    expect(createCf).not.toHaveBeenCalled();
  });
});

describe("a Gateway from before the event tables", () => {
  it("refuses every command that needs them with GATEWAY_OUTDATED, pointing at update", async () => {
    await sql("DROP TABLE event_deliveries");
    await sql("DROP TABLE events");
    await sql("DROP TABLE event_subscriptions");
    for (const body of [
      (out: EventSink) => listEvents({ flags, out, createCf }),
      (out: EventSink) => addEvents({ flags, out, createCf, readStdin: async () => null }, URL_),
      (out: EventSink) => testEvents({ flags, out, createCf }, "sub_x"),
      (out: EventSink) => redeliverOne({ flags, out, createCf }, "dlv_x"),
    ]) {
      lines = [];
      await run(body);
      expect(error()).toMatchObject({
        code: "GATEWAY_OUTDATED",
        message: expect.stringMatching(/^The Gateway predates events\n/),
        data: { rerun: "pnpm everyapp update" },
      });
    }
  });
});
