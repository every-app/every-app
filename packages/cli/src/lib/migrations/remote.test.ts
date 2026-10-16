import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cfD1Database, restoreCommand } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import {
  createSqliteD1,
  GATEWAY_MIGRATIONS_DIR,
  migrateGatewayWithDrizzle,
  sqliteD1Script,
  type SqliteD1,
} from "@/test/sqliteD1";
import {
  backfillD1Migrations,
  migrateRemoteD1,
  readDrizzleJournal,
  type JournalEntry,
} from "./remote";

const DB_ID = "0123456789abcdef0123456789abcdef";

/**
 * A drizzle-kit history of several migrations, one table each: the
 * gateway's own is a single generated baseline.
 */
function writeDrizzleHistory(dir: string, count: number): void {
  const entries = Array.from({ length: count }, (_, idx) => ({
    idx,
    version: "6",
    when: 1_000 * (idx + 1),
    tag: `${String(idx).padStart(4, "0")}_t${idx}`,
    breakpoints: true,
  }));
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  for (const { idx, tag } of entries) {
    fs.writeFileSync(path.join(dir, `${tag}.sql`), `CREATE TABLE t${idx} (id text);`);
  }
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }),
  );
}

let historyDir: string;
let db: SqliteD1;
let journal: JournalEntry[];

beforeAll(() => {
  historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-history-"));
  writeDrizzleHistory(historyDir, 4);
});
afterAll(() => fs.rmSync(historyDir, { recursive: true, force: true }));

beforeEach(async () => {
  db = createSqliteD1();
  journal = (await readDrizzleJournal(historyDir))!;
});

describe("backfillD1Migrations", () => {
  it("marks exactly what drizzle applied, by drizzle's own rule", async () => {
    migrateGatewayWithDrizzle(db, 3, historyDir);

    const marked = await backfillD1Migrations({
      db,
      journal,
      nameFor: (tag) => `${tag}.sql`,
    });

    expect(marked).toEqual(journal.slice(0, 3).map((e) => `${e.tag}.sql`));
    expect(db.all("SELECT name FROM d1_migrations ORDER BY id")).toEqual(
      marked.map((name) => ({ name })),
    );
  });

  it("runs once: never again after cf has recorded migrations", async () => {
    migrateGatewayWithDrizzle(db, 3, historyDir);
    await backfillD1Migrations({ db, journal, nameFor: (t) => `${t}.sql` });
    db.sqlite.exec("DELETE FROM d1_migrations WHERE id > 1");

    await expect(
      backfillD1Migrations({ db, journal, nameFor: (t) => `${t}.sql` }),
    ).resolves.toEqual([]);
    expect(db.all("SELECT COUNT(*) AS n FROM d1_migrations")).toEqual([
      { n: 1 },
    ]);
  });

  it("refuses a history that ran migrations this release dates differently", async () => {
    // As on a database an unreleased branch migrated: its own migrations
    // carry dates between this release's, so fewer rows than dated entries.
    migrateGatewayWithDrizzle(db, 3, historyDir);
    db.sqlite.exec(
      `DELETE FROM __drizzle_migrations WHERE created_at = ${journal[1]!.when}`,
    );

    await expect(
      backfillD1Migrations({ db, journal, nameFor: (t) => `${t}.sql` }),
    ).rejects.toMatchObject({ code: "MIGRATION_HISTORY_MISMATCH" });
    expect(
      db.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
  });

  it("does nothing for a database drizzle never migrated", async () => {
    await expect(
      backfillD1Migrations({ db, journal, nameFor: (t) => `${t}.sql` }),
    ).resolves.toEqual([]);
    expect(
      db.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
  });
});

describe("migrateRemoteD1", () => {
  let cf: FakeCf;
  let progress: string[];

  beforeEach(() => {
    progress = [];
    cf = new FakeCf()
      .on(["d1", "time-travel", "get-bookmark"], {
        stdout: JSON.stringify({ bookmark: "00000085-bookmark" }),
      })
      .on((args) => args[0] === "d1", sqliteD1Script({ [DB_ID]: db }));
  });

  const migrate = (dir = historyDir) =>
    migrateRemoteD1({
      cf,
      db: cfD1Database(cf, DB_ID),
      databaseId: DB_ID,
      dir,
      journal,
      onProgress: (message) => progress.push(message),
    });

  it("bookmarks, carries drizzle's history over, then applies only what's new", async () => {
    migrateGatewayWithDrizzle(db, journal.length - 1, historyDir);

    const result = await migrate();

    expect(result.bookmark).toBe("00000085-bookmark");
    expect(result.backfilled).toHaveLength(journal.length - 1);
    expect(result.applied).toEqual([`${journal.at(-1)!.tag}.sql`]);
    expect(cf.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["d1", "time-travel", "get-bookmark"],
      // Which bookkeeping tables exist, drizzle's newest, then the backfill.
      ["d1", "query", DB_ID],
      ["d1", "query", DB_ID],
      ["d1", "query", DB_ID],
      ["d1", "migrations", "apply"],
    ]);
    // Everything goes through the account plane with an absolute --dir.
    const apply = cf.calls.at(-1)!;
    expect(apply.plane).toBe("account");
    expect(apply.args).toEqual([
      "d1",
      "migrations",
      "apply",
      DB_ID,
      "--dir",
      historyDir,
    ]);
    // A rollback that runs where no one can answer cf's question.
    expect(progress[0]).toContain(
      `d1 time-travel restore ${DB_ID} --bookmark 00000085-bookmark --force`,
    );
  });

  it("applies everything to a fresh database", async () => {
    const result = await migrate(GATEWAY_MIGRATIONS_DIR);
    expect(result.backfilled).toEqual([]);
    expect(result.applied).toEqual(
      fs.readdirSync(GATEWAY_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")),
    );
    expect(db.all("SELECT COUNT(*) AS n FROM apps")).toEqual([{ n: 0 }]);
  });

  describe("a failing migration", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-"));
      fs.writeFileSync(path.join(dir, "0000_ok.sql"), "CREATE TABLE a (id text);");
      fs.writeFileSync(path.join(dir, "0001_bad.sql"), "CREATE TABLE a (id text);");
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("stops with the bookmark's restore command, before any upload", async () => {
      const failure = migrate(dir);
      await expect(failure).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
      await expect(failure).rejects.toThrow(
        /version that is serving keeps running[\s\S]*--bookmark 00000085-bookmark/,
      );
      // The good migration landed; the bad one rolled back as a unit.
      expect(db.all("SELECT name FROM d1_migrations")).toEqual([
        { name: "0000_ok.sql" },
      ]);
    });
  });

  it("fails when cf marks a migration ❌, though it exits 0", async () => {
    cf = new FakeCf()
      .on(["d1", "time-travel"], { stdout: '{"bookmark":"b"}' })
      .on(["d1", "query"], { stdout: '[{"results":[]}]' })
      .on(["d1", "migrations"], {
        stdout: JSON.stringify([
          { name: "0000_a.sql", status: "✅" },
          { name: "0001_b.sql", status: "❌" },
          { name: "0002_c.sql", status: "✅" },
        ]),
      });

    const failure = migrateRemoteD1({
      cf,
      db: cfD1Database(cf, DB_ID),
      databaseId: DB_ID,
      accountId: "acct-1",
      dir: GATEWAY_MIGRATIONS_DIR,
    });
    await expect(failure).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      message: expect.stringContaining("0001_b.sql ❌"),
    });
    await expect(failure).rejects.toThrow(restoreCommand(DB_ID, "b", "acct-1"));
  });

  it("prints the rollback in the syntax of the shell it is pasted into", () => {
    expect(restoreCommand(DB_ID, "b", "acct-1", { platform: "linux" })).toMatch(
      new RegExp(
        `^CLOUDFLARE_ACCOUNT_ID=acct-1 npx cf@\\S+ d1 time-travel restore ${DB_ID} --bookmark b --force$`,
      ),
    );
    // PowerShell: no SHELL.
    expect(restoreCommand(DB_ID, "b", "acct-1", { platform: "win32", shell: "" })).toMatch(
      /^\$env:CLOUDFLARE_ACCOUNT_ID="acct-1"; npx cf@\S+ d1 time-travel restore /,
    );
    // Git Bash.
    expect(
      restoreCommand(DB_ID, "b", "acct-1", { platform: "win32", shell: "/usr/bin/bash" }),
    ).toMatch(/^CLOUDFLARE_ACCOUNT_ID=acct-1 npx cf@/);
    expect(restoreCommand(DB_ID, "b", undefined, { platform: "win32", shell: "" })).toMatch(
      /^npx cf@/,
    );
  });

  it("knows drizzle-kit's nested layout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-"));
    fs.mkdirSync(path.join(dir, "20261012_init"));
    fs.writeFileSync(
      path.join(dir, "20261012_init", "migration.sql"),
      "CREATE TABLE a (id text);",
    );
    cf = new FakeCf()
      .on(["d1", "time-travel"], { stdout: '{"bookmark":"b"}' })
      .on(["d1", "query"], { stdout: '[{"results":[]}]' })
      .on(["d1", "migrations"], { stdout: "[]" });

    await migrate(dir);

    expect(cf.calls.at(-1)!.args).toEqual([
      "d1",
      "migrations",
      "apply",
      DB_ID,
      "--dir",
      dir,
      "--pattern",
      path.join(dir, "*", "migration.sql"),
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
