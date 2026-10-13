import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localD1Id } from "@every-app/sdk/cloudflare";
import { FakeCf } from "@/lib/cf/fakeCf";
import { applyDevMigrations } from "./migrations";

const manifest = {
  id: "todo",
  resources: { d1: ["DB"] },
  migrations: { engine: "drizzle" as const },
};

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-dev-migrations-"));
  await fs.mkdir(path.join(cwd, "drizzle"));
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("applyDevMigrations", () => {
  it("applies the migrations to the database cf dev serves", async () => {
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: '[{"name":"0000_init.sql","status":"✅"}]',
    });

    const result = await applyDevMigrations({
      cwd,
      manifest,
      cf,
      skipMigrations: false,
    });

    expect(result).toBe(true);
    expect(cf.calls).toHaveLength(1);
    expect(cf.calls[0]).toMatchObject({
      args: [
        "d1",
        "migrations",
        "apply",
        localD1Id("every-todo", "DB"),
        "--local",
        "--persist-to",
        ".cloudflare/state",
        "--dir",
        "drizzle",
      ],
      plane: "project",
      cwd,
      local: true,
      env: {
        CLOUDFLARE_REGISTRY_PATH: path.join(cwd, ".everyapp", "registry"),
        MINIFLARE_REGISTRY_PATH: path.join(cwd, ".everyapp", "registry"),
      },
    });
  });

  it("aborts dev with an actionable error when migration fails", async () => {
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      exitCode: 1,
      stderr: "┌ Error\n│ migration 0001 failed\n└\n",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await applyDevMigrations({
      cwd,
      manifest,
      cf,
      skipMigrations: false,
    });

    expect(result).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("migration 0001 failed"),
    );
    expect(error).toHaveBeenCalledWith(
      "Run manually: pnpm run db:migrate:local",
    );
  });

  it("--skip-migrations bypasses migration application", async () => {
    const cf = new FakeCf();

    const result = await applyDevMigrations({
      cwd,
      manifest,
      cf,
      skipMigrations: true,
    });

    expect(result).toBe(true);
    expect(cf.calls).toHaveLength(0);
  });
});
