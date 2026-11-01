import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreCommand } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import { readRestorePoint, recordRestorePoint } from "@/lib/gateway/restorePoints";
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
const WHOAMI = JSON.stringify({
  authenticated: true,
  email: "dev@example.com",
  accounts: [{ id: "acct-1", name: "Acme" }],
});

let db: SqliteD1;
let registry: SqliteD1;

beforeEach(() => {
  db = createSqliteD1();
  registry = createSqliteD1();
});

describe("migrateRemoteD1", () => {
  let cf: FakeCf;

  beforeEach(() => {
    cf = new FakeCf()
      .on(["auth", "whoami"], { stdout: WHOAMI })
      .on(["d1", "time-travel", "get-bookmark"], {
        stdout: JSON.stringify({ bookmark: "00000085-bookmark" }),
      })
      .on((args) => args[0] === "d1", sqliteD1Script({ [DB_ID]: db }));
  });

  const migrate = (dir = GATEWAY_MIGRATIONS_DIR) =>
    migrateRemoteD1({
      cf,
      databaseId: DB_ID,
      accountId: "acct-1",
      dir,
      registry,
      target: "app:every-todo",
      restoreCommand: "pnpm everyapp db restore",
    });

  it("migrates an empty database without a restore point: there is nothing to go back to", async () => {
    const result = await migrate();

    expect(result).toEqual({ applied: GATEWAY_MIGRATIONS, fresh: true, rollback: null });
    expect(db.all("SELECT COUNT(*) AS n FROM apps")).toEqual([{ n: 0 }]);
    expect(cf.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["d1", "migrations", "list"],
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
    await expect(readRestorePoint(registry, "app:every-todo")).resolves.toBeNull();
  });

  describe("a database with migrations already", () => {
    let dir: string;
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-"));
      fs.writeFileSync(path.join(dir, "0000_init.sql"), "CREATE TABLE a (id text);");
      await migrate(dir);
      cf.calls.length = 0;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("records a restore point before applying the new ones", async () => {
      fs.writeFileSync(path.join(dir, "0001_b.sql"), "CREATE TABLE b (id text);");
      fs.writeFileSync(path.join(dir, "0002_c.sql"), "CREATE TABLE c (id text);");

      const result = await migrate(dir);

      expect(result).toEqual({
        applied: ["0001_b.sql", "0002_c.sql"],
        fresh: false,
        rollback: {
          restoreCommand: "pnpm everyapp db restore",
          rollbackCommand: restoreCommand(DB_ID, "00000085-bookmark", "acct-1"),
        },
      });
      expect(cf.calls.map((call) => call.args.slice(0, 3).join(" "))).toEqual([
        "d1 migrations list",
        "d1 time-travel get-bookmark",
        "auth whoami",
        "d1 migrations apply",
      ]);
      await expect(readRestorePoint(registry, "app:every-todo")).resolves.toMatchObject({
        databaseId: DB_ID,
        bookmark: "00000085-bookmark",
        migrations: ["0001_b.sql", "0002_c.sql"],
        createdBy: "dev@example.com",
      });
    });

    it("leaves a database that is up to date alone: no bookmark, no restore point", async () => {
      await expect(migrate(dir)).resolves.toEqual({ applied: [], fresh: false, rollback: null });
      expect(cf.calls.map((call) => call.args.slice(0, 3).join(" "))).toEqual([
        "d1 migrations list",
      ]);
      await expect(readRestorePoint(registry, "app:every-todo")).resolves.toBeNull();
    });

    it("stops a failing migration before any upload, saying how to restore", async () => {
      fs.writeFileSync(path.join(dir, "0001_ok.sql"), "CREATE TABLE b (id text);");
      fs.writeFileSync(path.join(dir, "0002_bad.sql"), "CREATE TABLE a (id text);");

      const failure = migrate(dir);
      await expect(failure).rejects.toMatchObject({
        code: "MIGRATION_FAILED",
        data: {
          fix: "correct the migration",
          rollbackCommand: expect.stringContaining("--bookmark 00000085-bookmark"),
        },
      });
      await expect(failure).rejects.toThrow(
        /^Database migration failed\n[\s\S]*keeps running\.\nTo roll the database back to before this run: pnpm everyapp db restore$/,
      );
      // The good migration landed; the bad one rolled back as a unit.
      expect(db.all("SELECT name FROM d1_migrations")).toEqual([
        { name: "0000_init.sql" },
        { name: "0001_ok.sql" },
      ]);
      // The restore point names both: it goes back to before either.
      await expect(readRestorePoint(registry, "app:every-todo")).resolves.toMatchObject({
        migrations: ["0001_ok.sql", "0002_bad.sql"],
      });
    });
  });

  it("forgets a restore point of a database an empty one replaced", async () => {
    await recordRestorePoint(registry, {
      target: "app:every-todo",
      databaseId: "an-old-database",
      bookmark: "b",
      migrations: ["0000_init.sql"],
      createdAt: 1,
      createdBy: "dev@example.com",
    });

    await migrate();

    await expect(readRestorePoint(registry, "app:every-todo")).resolves.toBeNull();
  });

  it("fails when cf marks a migration ❌, though it exits 0", async () => {
    cf = new FakeCf()
      .on(["auth", "whoami"], { stdout: WHOAMI })
      .on(["d1", "time-travel"], { stdout: '{"bookmark":"b"}' })
      .on(["d1", "migrations", "list"], {
        stdout: JSON.stringify([{ Name: "0001_b.sql" }, { Name: "0002_c.sql" }]),
      })
      .on(["d1", "migrations"], {
        stdout: JSON.stringify([
          { name: "0001_b.sql", status: "❌" },
          { name: "0002_c.sql", status: "✅" },
        ]),
      });

    const failure = migrate();
    await expect(failure).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      message: expect.stringContaining("0001_b.sql ❌"),
      data: { rollbackCommand: restoreCommand(DB_ID, "b", "acct-1") },
    });
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
      .on(["d1", "migrations", "list"], {
        stdout: JSON.stringify([{ Name: "20261012_init/migration.sql" }]),
      })
      .on(["d1", "migrations"], { stdout: "[]" });

    await migrate(dir);

    const dirArgs = ["--dir", dir, "--pattern", path.join(dir, "*", "migration.sql")];
    expect(cf.calls.map((call) => call.args)).toEqual([
      ["d1", "migrations", "list", DB_ID, ...dirArgs],
      ["d1", "migrations", "apply", DB_ID, ...dirArgs],
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
