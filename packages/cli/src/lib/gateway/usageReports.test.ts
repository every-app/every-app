/**
 * Usage reports at setup and update, against the Gateway's real schema in
 * SQLite: what the migration records, the two ways to leave reports off
 * before a Gateway ever sends one, and the notice a run prints.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createSqliteD1, GATEWAY_MIGRATIONS_DIR, sqliteD1Script, type SqliteD1 } from "@/test/sqliteD1";
import { isPublishedRelease } from "./release";
import { usageReportsAtSetup } from "./usageReports";

const DB_ID = "0123456789abcdef0123456789abcdef";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-16T12:00:00Z");

let db: SqliteD1;
const row = () => db.all("SELECT * FROM telemetry_state")[0]!;
const set = (sql: string, ...params: Array<string | number | null>) => db.sqlite.prepare(`UPDATE telemetry_state SET ${sql}`).run(...params);
/** The Gateway got usage reports at NOW: by an update (`existing`), or a new setup. */
const gateway = (existing: boolean) => set("existing = ?, created_at = ?", existing ? 1 : 0, NOW);

beforeEach(async () => {
  db = createSqliteD1();
  const cf = new FakeCf().on(["d1"], sqliteD1Script({ [DB_ID]: db }));
  await cf.run({ plane: "account", mode: "json", args: ["d1", "migrations", "apply", DB_ID, "--dir", GATEWAY_MIGRATIONS_DIR] });
});

describe("the telemetry_state migration", () => {
  const insert = fs
    .readFileSync(path.join(GATEWAY_MIGRATIONS_DIR, "0038_telemetry_state.sql"), "utf8")
    .split("--> statement-breakpoint")
    .at(-1)!;

  it("writes the one row: a new Gateway, nothing chosen, a random id", () => {
    expect(db.all("SELECT * FROM telemetry_state")).toHaveLength(1);
    expect(row()).toMatchObject({ id: "telemetry", existing: 0, enabled: null, reported_day: null });
    expect(row()["install_id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(Math.abs(Number(row()["created_at"]) - Date.now())).toBeLessThan(60_000);
  });

  it("records a Gateway that already had an owner as existing", () => {
    db.sqlite.exec("DELETE FROM telemetry_state");
    db.sqlite.exec("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 0)");
    db.sqlite.exec("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'Ann', 'ann@example.com', 1, 0, 0)");
    db.sqlite.exec("INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m1', 'org-1', 'u1', 'owner', 0)");
    db.sqlite.exec(insert);
    expect(row()).toMatchObject({ existing: 1, enabled: null });
  });
});

describe("usage reports at setup and update", () => {
  const run = (options: Partial<Parameters<typeof usageReportsAtSetup>[0]> = {}) =>
    usageReportsAtSetup({ db, noTelemetry: false, published: true, env: {}, now: NOW + 60_000, ...options });

  it("an update of a Gateway that existed gives seven days' notice", async () => {
    gateway(true);
    expect(await run()).toEqual({
      usageReports: "on",
      startsAt: "2026-11-23T12:00:00.000Z",
      notice: {
        headline: "Usage reports start on 23 November for this Gateway.",
        detail:
          "Once a day it will send Every App a few rounded counts: members, apps, MCP servers, how many people used them, AI tool calls, the version. Never your domain, names, emails or anything inside an app.",
      },
    });
    // Every update until then says it again; after, nothing.
    expect(await run({ now: NOW + 6 * DAY })).toMatchObject({ usageReports: "on" });
    expect(await run({ now: NOW + 7 * DAY })).toBeNull();
    // Nothing was written: the Gateway's own switch is the only thing that changes the choice.
    expect(row()).toMatchObject({ enabled: null, changed_by: null });
  });

  it("a new Gateway is told the first report goes a day later", async () => {
    gateway(false);
    expect(await run()).toMatchObject({ usageReports: "on", startsAt: "2026-11-17T12:00:00.000Z" });
  });

  it("--no-telemetry leaves reports off before the Gateway ever sends, and deletes the id", async () => {
    gateway(false);
    expect(await run({ noTelemetry: true })).toEqual({ usageReports: "off", because: "no-telemetry" });
    expect(row()).toMatchObject({ enabled: 0, install_id: null, changed_by: "cli:no-telemetry", changed_at: NOW + 60_000 });
    // It stays off on the next run, which has nothing more to say.
    expect(await run()).toBeNull();
    // Even over a choice made at the Gateway: the flag is explicit.
    set("enabled = 1");
    expect(await run({ noTelemetry: true })).toEqual({ usageReports: "off", because: "no-telemetry" });
    expect(row()).toMatchObject({ enabled: 0 });
  });

  it("DO_NOT_TRACK in the shell leaves reports off, at setup and at update", async () => {
    for (const existing of [false, true]) {
      gateway(existing);
      set("enabled = NULL, changed_by = NULL");
      expect(await run({ env: { DO_NOT_TRACK: "1" } })).toEqual({ usageReports: "off", because: "do-not-track" });
      expect(row()).toMatchObject({ enabled: 0, install_id: null, changed_by: "cli:do-not-track" });
    }
    // DO_NOT_TRACK=0 is not a request.
    gateway(true);
    set("enabled = NULL");
    expect(await run({ env: { DO_NOT_TRACK: "0" } })).toMatchObject({ usageReports: "on" });
    // An owner who turned reports on at the Gateway keeps them: the variable doesn't undo a choice.
    set("enabled = 1, changed_by = 'user-1'");
    expect(await run({ env: { DO_NOT_TRACK: "1" } })).toMatchObject({ usageReports: "on" });
    expect(row()).toMatchObject({ enabled: 1, changed_by: "user-1" });
  });

  it("says nothing about a Gateway that can't send, but still turns reports off when asked", async () => {
    gateway(true);
    expect(await run({ published: false })).toBeNull();
    expect(await run({ published: false, env: { DO_NOT_TRACK: "1" } })).toEqual({ usageReports: "off", because: "do-not-track" });
    expect(row()).toMatchObject({ enabled: 0 });
  });

  it("says nothing on a release from before usage reports", async () => {
    db.sqlite.exec("DROP TABLE telemetry_state");
    expect(await run({ noTelemetry: true })).toBeNull();
  });
});

describe("which releases send", () => {
  it("only one downloaded from Every App's own repository", () => {
    expect(isPublishedRelease({ kind: "github", repo: "every-app/every-app", tag: "gateway-v0.4.2" })).toBe(true);
    expect(isPublishedRelease({ kind: "github", repo: "acme/every-app", tag: "gateway-v0.4.2" })).toBe(false);
    expect(isPublishedRelease({ kind: "checkout" })).toBe(false);
    expect(isPublishedRelease({ kind: "url", url: "https://example.com/every-app-gateway-release.tar.gz" })).toBe(false);
    expect(isPublishedRelease({ kind: "file", path: "/tmp/every-app-gateway-release.tar.gz" })).toBe(false);
  });
});
