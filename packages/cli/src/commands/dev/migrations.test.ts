import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDevMigrations } from "./migrations";

const mocks = vi.hoisted(() => ({
  runLocalAppMigrations: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runLocalAppMigrations: mocks.runLocalAppMigrations,
}));

const manifest = {
  id: "todo",
  resources: { d1: ["DB"] },
  migrations: { engine: "drizzle" as const },
};

describe("applyDevMigrations", () => {
  beforeEach(() => {
    mocks.runLocalAppMigrations.mockReset();
    process.exitCode = undefined;
  });

  it("continues after local migrations succeed", async () => {
    const result = await applyDevMigrations({
      cwd: "/app",
      manifest,
      configPath: "/app/.everyapp/wrangler.json",
      skipMigrations: false,
    });

    expect(result).toBe(true);
    expect(mocks.runLocalAppMigrations).toHaveBeenCalledWith({
      cwd: "/app",
      d1Bindings: ["DB"],
      migrations: manifest.migrations,
      configPath: "/app/.everyapp/wrangler.json",
    });
  });

  it("aborts dev with an actionable error when migration fails", async () => {
    mocks.runLocalAppMigrations.mockRejectedValue(
      new Error("migration 0001 failed"),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await applyDevMigrations({
      cwd: "/app",
      manifest,
      configPath: "/app/.everyapp/wrangler.json",
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
    error.mockRestore();
  });

  it("--skip-migrations bypasses migration application", async () => {
    const result = await applyDevMigrations({
      cwd: "/app",
      manifest,
      configPath: path.join("/app", ".everyapp", "wrangler.json"),
      skipMigrations: true,
    });

    expect(result).toBe(true);
    expect(mocks.runLocalAppMigrations).not.toHaveBeenCalled();
  });
});
