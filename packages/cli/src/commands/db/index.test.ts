import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { migrateLocal, queryAppD1 } from "./index";
import { formatQueryResults, readsOnly } from "./queryOutput";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-d1-migrate-"));
  await fs.writeFile(
    path.join(cwd, "everyapp.config.ts"),
    'export default { id: "todo", resources: { d1: ["DB"] } };\n',
  );
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function ndjson() {
  const lines: string[] = [];
  const out = createNdjsonSink((line) => lines.push(line));
  const events = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { out, events };
}

/** `everyapp db migrate --json`, as runReported reports it. */
async function migrate(options: Parameters<typeof migrateLocal>[0]) {
  try {
    await migrateLocal(options);
    options.out.emit({ type: "done" });
  } catch (error) {
    reportFailure(options.out, error);
  }
}

describe("migrateLocal", () => {
  it("reports the applied migrations as NDJSON and exits 0", async () => {
    await fs.mkdir(path.join(cwd, "drizzle"));
    const { out, events } = ndjson();
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: '[{"name":"0000_init.sql","status":"✅"}]',
    });

    await migrate({ cwd, out, cf });

    expect(events().map((event) => [event["type"], event["status"]])).toEqual([
      ["step", "start"],
      ["step", "ok"],
      ["done", undefined],
    ]);
    expect(events()[1]).toMatchObject({
      step: "db.migrate",
      data: { applied: ["0000_init.sql"] },
    });
    expect(out.exitCode).toBe(0);
  });

  it("skips an app without a migrations directory, never starting a step", async () => {
    const { out, events } = ndjson();
    await migrate({ cwd, out, cf: new FakeCf() });

    expect(events()[0]).toMatchObject({
      type: "step",
      status: "skip",
      message: "No migrations in drizzle/ yet, so there's nothing to migrate.",
      data: { reason: "no_migrations_dir" },
    });
    expect(out.exitCode).toBe(0);
  });

  it("names the migration that failed, and the file to fix", async () => {
    await fs.mkdir(path.join(cwd, "drizzle"));
    const { out, events } = ndjson();
    const cf = new FakeCf()
      .on(["d1", "migrations", "apply"], {
        exitCode: 1,
        stderr: '┌ Error\n│ near "CREAT": syntax error at offset 0: SQLITE_ERROR\n└\n',
      })
      .on(["d1", "migrations", "list"], {
        stdout: '[{"Name":"0001_add_events.sql"},{"Name":"0002_more.sql"}]',
      });

    await migrate({ cwd, out, cf });

    expect(events().at(-1)).toMatchObject({
      type: "error",
      code: "MIGRATIONS_FAILED",
      message: 'Migration 0001_add_events.sql failed\nnear "CREAT": syntax error at offset 0 (SQLITE_ERROR)',
      data: { migration: "0001_add_events.sql", fix: "correct drizzle/0001_add_events.sql" },
    });
    expect(out.exitCode).toBe(1);
  });

  it("only ever migrates the local database", async () => {
    await fs.mkdir(path.join(cwd, "drizzle"));
    const { out } = ndjson();
    const cf = new FakeCf().on(["d1", "migrations", "apply"], { stdout: "[]" });

    await migrate({ cwd, out, cf });

    expect(cf.calls.map((call) => call.args)).toEqual([
      expect.arrayContaining(["d1", "migrations", "apply", "--local"]),
    ]);
    expect(out.exitCode).toBe(0);
  });

  it("says there is no everyapp.config.ts here", async () => {
    await fs.rm(path.join(cwd, "everyapp.config.ts"));
    const { out, events } = ndjson();

    await migrate({ cwd, out, cf: new FakeCf() });

    expect(events().at(-1)).toMatchObject({
      type: "error",
      code: "MANIFEST_NOT_FOUND",
      message: "No everyapp.config.ts in this directory",
      data: { fix: "run this from the app's directory" },
    });
  });
});

describe("queryAppD1", () => {
  const local = (sql: string, binding?: string) =>
    queryAppD1({ cwd, sql, local: true, binding, out: ndjson().out, cf });
  let cf: FakeCf;
  beforeEach(() => {
    cf = new FakeCf().on(["d1", "raw"], {
      stdout: JSON.stringify([
        {
          results: { columns: ["id", "title"], rows: [[1, "Ship"], [2, null]] },
          meta: { duration: 0.4, changes: 0 },
        },
      ]),
    });
  });

  it("keeps D1's time and changes with each statement's rows", async () => {
    await expect(local("select id, title from todos")).resolves.toEqual([
      { rows: [{ id: 1, title: "Ship" }, { id: 2, title: null }], duration: 0.4, changes: 0 },
    ]);
  });

  it("names the bindings there are when the one asked for isn't", async () => {
    await expect(local("select 1", "OTHER")).rejects.toMatchObject({
      code: "UNKNOWN_D1_BINDING",
      message: "No D1 binding OTHER in everyapp.config.ts\nIt declares DB.",
    });
  });

  it("says how to add a database to an app without one", async () => {
    await fs.writeFile(path.join(cwd, "everyapp.config.ts"), 'export default { id: "todo" };\n');
    await expect(local("select 1")).rejects.toMatchObject({
      code: "NO_D1",
      message: "todo declares no D1 database",
      rerun: "pnpm everyapp deploy",
    });
  });
});

describe("formatQueryResults", () => {
  const plain = (...args: Parameters<typeof formatQueryResults>) =>
    stripVTControlCharacters(formatQueryResults(...args));

  it("draws rows as a table, with a footer", () => {
    expect(
      plain(
        [
          {
            rows: [
              { id: 1, title: "Ship analytics", done: 0 },
              { id: 2, title: "Write docs", done: 1 },
            ],
            duration: 38.2,
            changes: 0,
          },
        ],
        "production",
      ),
    ).toBe(
      [
        "id  title           done",
        "1   Ship analytics  0",
        "2   Write docs      1",
        "",
        "2 rows · production · 38ms",
      ].join("\n"),
    );
  });

  it("says how many rows a write changed, and that a select found none", () => {
    expect(plain([{ rows: [], duration: 21, changes: 3 }], "production")).toBe(
      "3 rows changed ✓ production · 21ms",
    );
    expect(plain([{ rows: [], duration: 0.2, changes: 0 }], "local")).toBe(
      "0 rows · local · <1ms",
    );
  });

  it("draws one table per statement", () => {
    expect(
      plain(
        [
          { rows: [{ n: 2 }], duration: 10, changes: 0 },
          { rows: [{ n: 5 }], duration: 20, changes: 0 },
        ],
        "production",
      ),
    ).toBe(["n", "2", "", "n", "5", "", "2 statements · production · 30ms"].join("\n"));
  });
});

describe("readsOnly", () => {
  it("lets reads through without asking", () => {
    expect(readsOnly("select * from todos limit 5")).toBe(true);
    expect(readsOnly("SELECT count(*) n FROM todos; select 1;")).toBe(true);
    expect(readsOnly("with t as (select 1) select * from t")).toBe(true);
    expect(readsOnly("pragma table_info(todos)")).toBe(true);
  });

  it("asks about anything that might write", () => {
    expect(readsOnly("update todos set done = 1")).toBe(false);
    expect(readsOnly("select 1; delete from todos")).toBe(false);
    expect(readsOnly("with t as (select 1) delete from todos")).toBe(false);
    expect(readsOnly("pragma foreign_keys = off")).toBe(false);
    expect(readsOnly("-- a comment\nselect 1")).toBe(false);
    expect(readsOnly("")).toBe(false);
  });
});
