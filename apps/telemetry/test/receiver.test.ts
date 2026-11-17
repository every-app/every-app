import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { handle, parseReport, prune, type D1, type Env } from "../src/index";

const file = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const example = JSON.parse(file("example-report.json")) as Record<string, unknown>;
/** The day after the example's: the example is "yesterday's" report. */
const NOW = Date.parse("2026-11-21T00:17:00Z");

/** The real schema on an in-memory SQLite, behind the slice of D1 the Worker uses. */
function database(): { d1: D1; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  // Every migration in order, as `wrangler d1 migrations apply` runs them.
  for (const name of readdirSync(new URL("../migrations", import.meta.url)).sort()) sqlite.exec(file(`migrations/${name}`));
  const d1: D1 = {
    prepare(sql) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async run() {
          return sqlite.prepare(sql).run(...(values as (string | number)[]));
        },
      };
      return statement;
    },
  };
  return { d1, sqlite };
}

let env: Env;
let sqlite: DatabaseSync;
beforeEach(() => {
  const db = database();
  env = { DB: db.d1 };
  sqlite = db.sqlite;
});

const post = (body: unknown, init: RequestInit = {}) =>
  handle(
    new Request("https://telemetry.everyapp.com/v1/report", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "CF-Worker": "acme.com", "CF-Connecting-IP": "2a06:98c0:3600::103", "User-Agent": "x" },
      ...init,
    }),
    env,
    NOW,
  );
const rows = () => sqlite.prepare("SELECT * FROM reports ORDER BY install, day").all() as Record<string, unknown>[];

describe("the receiver", () => {
  it("stores the example report, and only what the report says", async () => {
    expect((await post(example)).status).toBe(204);
    expect(rows()).toEqual([
      {
        install: example.install,
        day: "2026-11-20",
        version: "0.4.2",
        installed: "2026-11",
        members: 7,
        active_members_1d: 3,
        active_members_7d: 4,
        apps: 3,
        mcp_servers: 2,
        app_use_1d: JSON.stringify(example.app_use_1d),
        mcp_active_members_1d: 1,
        mcp_tool_calls_1d: 20,
      },
    ]);
    // No address, zone name or receive time has a column to go in.
    expect(JSON.stringify(rows())).not.toMatch(/acme|2a06|2026-11-21/);
  });

  it("keeps the first report for a Gateway's day", async () => {
    await post(example);
    expect((await post({ ...example, members: 900 })).status).toBe(204);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.members).toBe(7);
  });

  it("accepts yesterday and the day before, and no other day", async () => {
    expect((await post({ ...example, day: "2026-11-19" })).status).toBe(204);
    for (const day of ["2026-11-21", "2026-11-18", "2026-11-2", "20 November"]) {
      expect((await post({ ...example, day })).status, day).toBe(400);
    }
  });

  it("refuses a key it doesn't know, and a missing one", async () => {
    expect(parseReport({ ...example, domain: "acme.com" }, NOW)).toBe("keys");
    expect(parseReport({ ...example, app_use_1d: [{ app: "crm", active_members: 1, tool_calls: 0, tools: ["x"] }] }, NOW)).toBe("app_use_1d");
    const { apps: _apps, ...missing } = example;
    expect(parseReport(missing, NOW)).toBe("keys");
    expect((await post({ ...example, domain: "acme.com" })).status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("refuses counts that aren't rounded to one significant digit, or are over the cap", () => {
    for (const members of [37, 11, 1001, 2000, -1, 1.5, "7", null]) {
      expect(parseReport({ ...example, members }, NOW), String(members)).toBe("members");
    }
    for (const members of [0, 7, 30, 900, 1000]) {
      expect(typeof parseReport({ ...example, members }, NOW), String(members)).toBe("object");
    }
    expect(parseReport({ ...example, app_use_1d: [{ app: "crm", active_members: 1, tool_calls: 4812 }] }, NOW)).toBe("app_use_1d");
    expect(typeof parseReport({ ...example, app_use_1d: [{ app: "crm", active_members: 1, tool_calls: 4000 }] }, NOW)).toBe("object");
  });

  it("refuses an app name that isn't one of ours, and a repeated one", () => {
    const use = (app: string) => ({ app, active_members: 1, tool_calls: 1 });
    expect(parseReport({ ...example, app_use_1d: [use("acme-payroll")] }, NOW)).toBe("app_use_1d");
    expect(parseReport({ ...example, app_use_1d: [use("crm"), use("crm")] }, NOW)).toBe("app_use_1d");
    expect(typeof parseReport({ ...example, app_use_1d: [] }, NOW)).toBe("object");
  });

  it("takes MCP servers apart from apps, as counts only", () => {
    expect(parseReport({ ...example, mcp_servers: 12 }, NOW)).toBe("mcp_servers");
    const { mcp_servers: _servers, ...none } = example;
    expect(parseReport(none, NOW)).toBe("keys");
    expect(parseReport({ ...example, mcp_use_1d: { active_members: 1, tool_calls: 21 } }, NOW)).toBe("mcp_use_1d");
    expect(parseReport({ ...example, mcp_use_1d: { active_members: 1, tool_calls: 20, servers: ["stripe"] } }, NOW)).toBe("mcp_use_1d");
    expect(parseReport({ ...example, mcp_use_1d: [] }, NOW)).toBe("mcp_use_1d");
    expect(typeof parseReport({ ...example, mcp_servers: 0, mcp_use_1d: { active_members: 0, tool_calls: 0 } }, NOW)).toBe("object");
    // An MCP server is never a row of app_use_1d.
    expect(parseReport({ ...example, app_use_1d: [{ app: "mcp", active_members: 1, tool_calls: 1 }] }, NOW)).toBe("app_use_1d");
  });

  it("refuses a malformed install ID, version or month", () => {
    expect(parseReport({ ...example, install: "5F0C1E9A7B3D4E21A8C6D2F4B9E07A13" }, NOW)).toBe("install");
    expect(parseReport({ ...example, install: "acme.com" }, NOW)).toBe("install");
    expect(parseReport({ ...example, version: "dev" }, NOW)).toBe("version");
    expect(typeof parseReport({ ...example, version: "0.5.0-rc.2" }, NOW)).toBe("object");
    expect(parseReport({ ...example, installed: "2026-11-03" }, NOW)).toBe("installed");
    expect(parseReport({ ...example, schema: 2 }, NOW)).toBe("schema");
  });

  it("answers only POST /v1/report, with a small JSON body", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(`{"pad":"${"x".repeat(5000)}"}`)).status).toBe(400);
    expect((await handle(new Request("https://telemetry.everyapp.com/v1/report"), env, NOW)).status).toBe(405);
    expect((await handle(new Request("https://telemetry.everyapp.com/"), env, NOW)).status).toBe(404);
    expect(rows()).toHaveLength(0);
  });

  it("deletes reports older than 25 months", async () => {
    await post(example);
    await prune(env, Date.parse("2028-12-01T00:00:00Z"));
    expect(rows()).toHaveLength(1);
    await prune(env, Date.parse("2028-12-21T00:00:00Z"));
    expect(rows()).toHaveLength(0);
  });

  it("adds the MCP columns to a table that already holds the first migration's rows", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(file("migrations/0001_reports.sql"));
    old.prepare("INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("a".repeat(32), "2026-11-19", "0.4.2", "2026-11", 7, 3, 4, 3, "[]");
    old.exec(file("migrations/0002_mcp_servers.sql"));
    expect(old.prepare("SELECT mcp_servers, mcp_active_members_1d, mcp_tool_calls_1d FROM reports").all()).toEqual([
      { mcp_servers: 0, mcp_active_members_1d: 0, mcp_tool_calls_1d: 0 },
    ]);
  });

  it("never reads a request header or logs", () => {
    const source = file("src/index.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/request\.headers|\.cf\b|console\./);
  });
});
