import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localD1Id } from "@every-app/sdk/cloudflare";
import { CfOutputError } from "@/lib/cf/errors";
import { FakeCf } from "@/lib/cf/fakeCf";
import { applyLocalMigrations, legacyLocalStateNote } from "./localD1";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-local-d1-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("applyLocalMigrations", () => {
  it("applies the default drizzle directory to the first D1 binding", async () => {
    await fs.mkdir(path.join(cwd, "drizzle"));
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: '[{"name":"0000_init.sql","status":"✅"}]',
    });

    const result = await applyLocalMigrations({
      cwd,
      manifest: { id: "todo", resources: { d1: ["DB", "AUDIT"] } },
      cf,
    });

    const database = localD1Id("every-todo", "DB");
    expect(result).toEqual({
      status: "applied",
      applied: ["0000_init.sql"],
      database,
    });
    expect(cf.calls[0]!.args).toEqual([
      "d1",
      "migrations",
      "apply",
      database,
      "--local",
      "--persist-to",
      ".cloudflare/state",
      "--dir",
      "drizzle",
    ]);
  });

  it("uses the configured binding and directory for d1-sql apps", async () => {
    await fs.mkdir(path.join(cwd, "migrations"));
    const cf = new FakeCf().on(["d1"], { stdout: "[]" });

    const result = await applyLocalMigrations({
      cwd,
      manifest: {
        id: "chef",
        resources: { d1: ["DB", "AUDIT"] },
        migrations: { engine: "d1-sql", dir: "migrations", binding: "AUDIT" },
      },
      cf,
    });

    expect(result).toMatchObject({ status: "applied", applied: [] });
    expect(cf.calls[0]!.args).toEqual(
      expect.arrayContaining([localD1Id("every-chef", "AUDIT"), "migrations"]),
    );
  });

  it("skips apps without D1 or without migrations yet", async () => {
    const cf = new FakeCf();
    await expect(
      applyLocalMigrations({ cwd, manifest: { id: "todo" }, cf }),
    ).resolves.toEqual({ status: "skipped", reason: "no_d1" });
    await expect(
      applyLocalMigrations({
        cwd,
        manifest: { id: "todo", resources: { d1: ["DB"] } },
        cf,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "no_migrations_dir" });
    expect(cf.calls).toHaveLength(0);
  });

  it("rejects output that isn't cf's migration list", async () => {
    await fs.mkdir(path.join(cwd, "drizzle"));
    const cf = new FakeCf().on(["d1"], { stdout: '{"applied":true}' });
    await expect(
      applyLocalMigrations({
        cwd,
        manifest: { id: "todo", resources: { d1: ["DB"] } },
        cf,
      }),
    ).rejects.toBeInstanceOf(CfOutputError);
  });
});

describe("legacyLocalStateNote", () => {
  it("explains a leftover .wrangler/state until .cloudflare/state exists", async () => {
    expect(await legacyLocalStateNote(cwd)).toBeNull();

    await fs.mkdir(path.join(cwd, ".wrangler", "state"), { recursive: true });
    expect(await legacyLocalStateNote(cwd)).toMatch(/\.cloudflare\/state/);

    await fs.mkdir(path.join(cwd, ".cloudflare", "state"), { recursive: true });
    expect(await legacyLocalStateNote(cwd)).toBeNull();
  });
});
