/**
 * The outbox (`queueEventFromCli`) against the Gateway's schema on SQLite,
 * through `cf d1 query` as a command sends it: the event row as the
 * Gateway's bus writes it, a pending delivery for each enabled
 * subscription of the organization whose patterns match, a dedupe key
 * that drops a second event and its deliveries, a condition that keeps a
 * write that didn't happen from being announced, and a Gateway from before
 * the event tables, where nothing is queued.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cfD1Database, type D1Statement } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createSqliteD1, GATEWAY_MIGRATIONS_DIR, sqliteD1Script, type SqliteD1 } from "@/test/sqliteD1";
import { eventPatterns, hasEventsTables, operatorActor, queueEventFromCli, subscriptionName } from "./events";

const DB_ID = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-25T09:00:00Z");
const ACTOR = operatorActor({ actor: "ben@example.com", email: "ben@example.com" });

let sqlite: SqliteD1;
let cf: FakeCf;

beforeEach(async () => {
  sqlite = createSqliteD1();
  cf = new FakeCf().on(["d1"], sqliteD1Script({ [DB_ID]: sqlite }));
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR],
  });
  for (const [id, name] of [
    ["org-1", "Acme"],
    ["org-2", "Beta"],
  ] as const) {
    sqlite.sqlite.prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, 0)").run(id, name, name.toLowerCase());
  }
});

const db = () => cfD1Database(cf, DB_ID);

function subscribe(id: string, events: string[], { organization = "org-1", enabled = true } = {}): void {
  sqlite.sqlite
    .prepare(
      "INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, events, enabled, created_at, updated_at) VALUES (?, ?, ?, 'webhook', 'https://hooks.example.org/x', 'whsec_x', ?, ?, 0, 0)",
    )
    .run(id, organization, id, JSON.stringify(events), enabled ? 1 : 0);
}

const queue = (overrides: Partial<Parameters<typeof queueEventFromCli>[1]> = {}) =>
  queueEventFromCli(db(), {
    organizationId: "org-1",
    type: "app.removed",
    actor: ACTOR,
    data: { app: { id: "crm", rowId: "row-1", name: "CRM" }, purged: false },
    appRowId: "row-1",
    now: NOW,
    ...overrides,
  });

const run = (statements: D1Statement[]) => db().run(statements);
const eventRows = () => sqlite.all("SELECT * FROM events");
const deliveryRows = () => sqlite.all("SELECT * FROM event_deliveries ORDER BY subscription_id");

describe("queueEventFromCli", () => {
  it("writes the event as the Gateway's bus does and a pending delivery, due now, for each matching subscription", async () => {
    subscribe("sub_all", ["*"]);
    subscribe("sub_apps", ["app.*"]);
    subscribe("sub_members", ["member.*"]);
    subscribe("sub_paused", ["*"], { enabled: false });
    subscribe("sub_theirs", ["*"], { organization: "org-2" });
    await run(await queue());

    const [event] = eventRows();
    expect(event).toMatchObject({
      organization_id: "org-1",
      type: "app.removed",
      version: 1,
      time: NOW,
      app_row_id: "row-1",
      dedupe_key: null,
      created_at: NOW,
    });
    expect(String(event!["id"])).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.parse(String(event!["actor"]))).toEqual({ kind: "operator", id: "ben@example.com", email: "ben@example.com" });
    expect(JSON.parse(String(event!["data"]))).toEqual({ app: { id: "crm", rowId: "row-1", name: "CRM" }, purged: false });
    // No summary and no envelope: the Gateway builds those when it delivers.
    expect(Object.keys(event!)).not.toContain("summary");
    expect(deliveryRows()).toEqual([
      expect.objectContaining({ subscription_id: "sub_all", event_id: event!["id"], organization_id: "org-1", status: "pending", attempts: 0, next_attempt_at: NOW, created_at: NOW }),
      expect.objectContaining({ subscription_id: "sub_apps", status: "pending" }),
    ]);
    expect(String(deliveryRows()[0]!["id"])).toMatch(/^dlv_[0-9a-f]{24}$/);
  });

  it("queues the event with no deliveries when nothing is subscribed, and an operator without an email as an API token", async () => {
    await run(await queue({ actor: operatorActor({ actor: "api-token:acct", email: null }) }));
    expect(eventRows()).toHaveLength(1);
    expect(JSON.parse(String(eventRows()[0]!["actor"]))).toEqual({ kind: "operator", id: "api-token:acct" });
    expect(deliveryRows()).toEqual([]);
  });

  it("drops a second event with the same dedupe key, deliveries and all", async () => {
    subscribe("sub_all", ["*"]);
    await run(await queue({ dedupeKey: "app.removed:org-1:row-1" }));
    await run(await queue({ dedupeKey: "app.removed:org-1:row-1", now: NOW + 1 }));
    expect(eventRows()).toHaveLength(1);
    expect(deliveryRows()).toHaveLength(1);
  });

  it("writes nothing when its condition is false when the batch runs", async () => {
    subscribe("sub_all", ["*"]);
    await run(await queue({ onlyIf: { sql: "EXISTS (SELECT 1 FROM apps WHERE id = ?)", params: ["row-missing"] } }));
    expect(eventRows()).toEqual([]);
    expect(deliveryRows()).toEqual([]);
  });

  it("delivers nothing to a subscription paused between the read and the batch", async () => {
    subscribe("sub_all", ["*"]);
    const statements = await queue();
    sqlite.sqlite.exec("UPDATE event_subscriptions SET enabled = 0");
    await run(statements);
    expect(eventRows()).toHaveLength(1);
    expect(deliveryRows()).toEqual([]);
  });

  it("refuses data with a key named like a credential, and a type the catalogue doesn't have", async () => {
    await expect(queue({ data: { app: { id: "crm" }, apiKey: "x" } })).rejects.toThrow(/apiKey/);
    await expect(queue({ type: "app.exploded" })).rejects.toThrow(/isn't in the event catalogue/);
  });

  it("queues nothing on a Gateway from before the event tables, and asks only once", async () => {
    sqlite.sqlite.exec("DROP TABLE event_deliveries; DROP TABLE events; DROP TABLE event_subscriptions");
    const database = db();
    expect(await queueEventFromCli(database, { organizationId: "org-1", type: "access.changed", actor: ACTOR, data: { access: "on" } })).toEqual([]);
    expect(await hasEventsTables(database)).toBe(false);
    expect(cf.calls.filter((call) => JSON.stringify(call.files).includes("PRAGMA table_info(events)"))).toHaveLength(1);
  });
});

describe("eventPatterns", () => {
  it("splits commas across repeated flags, keeps each once, and reads none or * as everything", () => {
    expect(eventPatterns(["cap.*, member.joined", "cap.*", "app.crm.*"])).toEqual(["cap.*", "member.joined", "app.crm.*"]);
    expect(eventPatterns(undefined)).toEqual(["*"]);
    expect(eventPatterns(["member.*,*"])).toEqual(["*"]);
  });
});

describe("subscriptionName", () => {
  it("is one trimmed line of at most 100 characters, or null for the default", () => {
    expect(subscriptionName("  Slack\n #ops ")).toBe("Slack #ops");
    expect(subscriptionName("   ")).toBeNull();
    expect(subscriptionName("x".repeat(150))).toHaveLength(100);
  });
});
