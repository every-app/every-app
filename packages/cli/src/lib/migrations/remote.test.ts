import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreCommand } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import {
  createSqliteD1,
  GATEWAY_MIGRATIONS_DIR,
  sqliteD1Script,
  type SqliteD1,
} from "@/test/sqliteD1";
import { migrateRemoteD1 } from "./remote";

const DB_ID = "0123456789abcdef0123456789abcdef";
const GATEWAY_MIGRATIONS = fs
  .readdirSync(GATEWAY_MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

let db: SqliteD1;

beforeEach(() => {
  db = createSqliteD1();
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

  const migrate = (dir = GATEWAY_MIGRATIONS_DIR) =>
    migrateRemoteD1({
      cf,
      databaseId: DB_ID,
      dir,
      onProgress: (message) => progress.push(message),
    });

  it("bookmarks, then has cf apply the migrations", async () => {
    const result = await migrate();

    expect(result.bookmark).toBe("00000085-bookmark");
    expect(result.applied).toEqual(GATEWAY_MIGRATIONS);
    expect(db.all("SELECT COUNT(*) AS n FROM apps")).toEqual([{ n: 0 }]);
    expect(cf.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["d1", "time-travel", "get-bookmark"],
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
      GATEWAY_MIGRATIONS_DIR,
    ]);
    // A rollback that runs where no one can answer cf's question.
    expect(progress[0]).toContain(
      `d1 time-travel restore ${DB_ID} --bookmark 00000085-bookmark --force`,
    );
  });

  it("applies nothing to a database that is up to date", async () => {
    await migrate();
    await expect(migrate()).resolves.toMatchObject({ applied: [] });
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
      .on(["d1", "migrations"], {
        stdout: JSON.stringify([
          { name: "0000_a.sql", status: "✅" },
          { name: "0001_b.sql", status: "❌" },
          { name: "0002_c.sql", status: "✅" },
        ]),
      });

    const failure = migrateRemoteD1({
      cf,
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
