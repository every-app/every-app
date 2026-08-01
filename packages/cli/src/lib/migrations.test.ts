import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  d1DatabaseNameForBinding,
  runAppMigrations,
  runLocalAppMigrations,
} from "./migrations";

const mocks = vi.hoisted(() => ({
  executeCommandWithFormatting: vi.fn(),
  runWithRemoteD1: vi.fn(),
}));

vi.mock("@/lib/formatting", () => ({
  executeCommandWithFormatting: mocks.executeCommandWithFormatting,
}));

vi.mock("@/lib/remote-d1", () => ({
  runWithRemoteD1: mocks.runWithRemoteD1,
}));

describe("runAppMigrations", () => {
  beforeEach(() => {
    mocks.executeCommandWithFormatting.mockReset();
    mocks.runWithRemoteD1.mockReset();
  });

  it("keeps the default Drizzle migration path", async () => {
    const cwd = await makeTempDir();
    const drizzleBin = await installFakePackageBin(
      cwd,
      "drizzle-kit",
      "drizzle-kit",
    );

    await runAppMigrations({
      cwd,
      workerName: "every-todo",
      d1Bindings: ["DB"],
      d1DatabaseIds: { DB: "database-id" },
      verbose: false,
    });

    expect(mocks.runWithRemoteD1).toHaveBeenCalledWith(
      process.execPath,
      [drizzleBin, "migrate", "--config=drizzle-prod.config.ts"],
      expect.objectContaining({
        cwd,
        d1DatabaseId: "database-id",
        verbose: false,
      }),
    );
    expect(mocks.executeCommandWithFormatting).not.toHaveBeenCalled();
  });

  it("applies d1-sql migrations with a minimal ephemeral Wrangler config", async () => {
    const cwd = await makeTempDir();
    const wranglerBin = await installFakeWrangler(cwd);
    await fs.mkdir(path.join(cwd, "migrations"));
    let writtenConfig: unknown;

    mocks.executeCommandWithFormatting.mockImplementation(
      async (_command: string, args: string[]) => {
        const configPath = args[args.indexOf("-c") + 1];
        if (!configPath) throw new Error("Expected Wrangler config path");
        writtenConfig = JSON.parse(await fs.readFile(configPath, "utf-8"));
      },
    );

    await runAppMigrations({
      cwd,
      workerName: "every-cal",
      d1Bindings: ["DB"],
      d1DatabaseIds: { DB: "database-id" },
      migrations: { engine: "d1-sql", dir: "migrations" },
      verbose: false,
    });

    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledWith(
      process.execPath,
      [
        wranglerBin,
        "d1",
        "migrations",
        "apply",
        "DB",
        "--remote",
        "-c",
        expect.stringContaining("wrangler.d1-migrations.json"),
      ],
      expect.objectContaining({
        cwd,
        verbose: false,
        logCommandToConsole: false,
      }),
    );
    expect(mocks.executeCommandWithFormatting.mock.calls[0]?.[1]).not.toContain(
      "--yes",
    );
    expect(writtenConfig).toEqual({
      d1_databases: [
        {
          binding: "DB",
          database_name: "every-cal",
          database_id: "database-id",
          migrations_dir: path.join(cwd, "migrations"),
        },
      ],
    });
  });

  it("uses the configured migration binding", async () => {
    const cwd = await makeTempDir();
    await installFakeWrangler(cwd);
    mocks.executeCommandWithFormatting.mockResolvedValue({});

    await runAppMigrations({
      cwd,
      workerName: "every-cal",
      d1Bindings: ["DB", "USERS"],
      d1DatabaseIds: { DB: "db-id", USERS: "users-id" },
      migrations: { engine: "d1-sql", dir: "migrations", binding: "USERS" },
      verbose: false,
    });

    expect(mocks.executeCommandWithFormatting.mock.calls[0]?.[1]).toContain(
      "USERS",
    );
  });

  it("does not attempt any command when the project has no local Wrangler", async () => {
    const cwd = await makeTempDir();
    await fs.writeFile(path.join(cwd, "package.json"), "{}", "utf-8");

    await expect(
      runAppMigrations({
        cwd,
        workerName: "every-cal",
        d1Bindings: ["DB"],
        d1DatabaseIds: { DB: "database-id" },
        migrations: { engine: "d1-sql", dir: "migrations" },
        verbose: false,
      }),
    ).rejects.toThrow("Install the project's declared wrangler dependency");

    expect(mocks.executeCommandWithFormatting).not.toHaveBeenCalled();
  });

  it("does not treat an empty configured binding as no D1 resources", async () => {
    const cwd = await makeTempDir();

    await expect(
      runAppMigrations({
        cwd,
        workerName: "every-cal",
        d1Bindings: ["DB"],
        d1DatabaseIds: { DB: "database-id" },
        migrations: { engine: "d1-sql", dir: "migrations", binding: "" },
        verbose: false,
      }),
    ).rejects.toThrow(
      'Manifest migrations binding "" is not declared in resources.d1.',
    );
  });
});

describe("runLocalAppMigrations", () => {
  beforeEach(() => {
    mocks.executeCommandWithFormatting.mockReset();
    mocks.runWithRemoteD1.mockReset();
  });

  it("applies Drizzle migrations to a fresh local database", async () => {
    const cwd = await makeTempDir();
    const wranglerBin = await installFakeWrangler(cwd);
    const drizzleBin = await installFakePackageBin(
      cwd,
      "drizzle-kit",
      "drizzle-kit",
    );
    await fs.mkdir(path.join(cwd, "drizzle"));
    await fs.mkdir(path.join(cwd, ".wrangler"));
    await fs.writeFile(path.join(cwd, ".wrangler", "cache.sqlite"), "");
    const configPath = path.join(cwd, ".everyapp", "wrangler.json");

    await runLocalAppMigrations({
      cwd,
      d1Bindings: ["DB"],
      migrations: { engine: "drizzle" },
      configPath,
    });

    expect(mocks.executeCommandWithFormatting).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [
        wranglerBin,
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        path.join(cwd, ".wrangler", "state"),
        "-c",
        configPath,
        "--command",
        "SELECT 1;",
      ],
      expect.objectContaining({
        cwd,
        logCommandToConsole: false,
      }),
    );
    expect(mocks.executeCommandWithFormatting).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      [drizzleBin, "migrate"],
      expect.objectContaining({
        cwd,
        logCommandToConsole: false,
      }),
    );
  });

  it("defaults to Drizzle when the manifest declares no migrations field", async () => {
    // None of the example apps spell out `migrations`, and runAppMigrations
    // already treats absent as drizzle. Skipping here instead would make the
    // dev preflight a silent no-op for exactly the apps people clone.
    const cwd = await makeTempDir();
    await installFakeWrangler(cwd);
    const drizzleBin = await installFakePackageBin(
      cwd,
      "drizzle-kit",
      "drizzle-kit",
    );
    await fs.mkdir(path.join(cwd, "drizzle"));

    await runLocalAppMigrations({
      cwd,
      d1Bindings: ["DB"],
      migrations: undefined,
      configPath: path.join(cwd, ".everyapp", "wrangler.json"),
    });

    expect(mocks.executeCommandWithFormatting).toHaveBeenLastCalledWith(
      process.execPath,
      [drizzleBin, "migrate"],
      expect.objectContaining({ cwd, logCommandToConsole: false }),
    );
  });

  it("reports progress when Drizzle finds the database up to date", async () => {
    const cwd = await makeTempDir();
    await installFakeWrangler(cwd);
    const drizzleBin = await installFakePackageBin(
      cwd,
      "drizzle-kit",
      "drizzle-kit",
    );
    await fs.mkdir(path.join(cwd, "drizzle"));
    const d1StatePath = path.join(
      cwd,
      ".wrangler",
      "state",
      "v3",
      "d1",
      "miniflare-D1DatabaseObject",
    );
    await fs.mkdir(d1StatePath, { recursive: true });
    await fs.writeFile(path.join(d1StatePath, "database.sqlite"), "");
    mocks.executeCommandWithFormatting.mockResolvedValue({
      stdout: "No migrations to apply",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runLocalAppMigrations({
      cwd,
      d1Bindings: ["DB"],
      migrations: { engine: "drizzle" },
      configPath: path.join(cwd, ".everyapp", "wrangler.json"),
    });

    expect(log).toHaveBeenNthCalledWith(
      1,
      chalk.dim("  Applying local database migrations..."),
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      chalk.dim("  Local migrations applied."),
    );
    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledOnce();
    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledWith(
      process.execPath,
      [drizzleBin, "migrate"],
      expect.objectContaining({
        cwd,
        logCommandToConsole: false,
      }),
    );
    log.mockRestore();
  });

  it("is a no-op when the app declares no D1 bindings", async () => {
    const cwd = await makeTempDir();

    await runLocalAppMigrations({
      cwd,
      d1Bindings: [],
      configPath: path.join(cwd, ".everyapp", "wrangler.json"),
    });

    expect(mocks.executeCommandWithFormatting).not.toHaveBeenCalled();
  });

  it("skips silently when the configured migrations directory is absent", async () => {
    const cwd = await makeTempDir();

    await runLocalAppMigrations({
      cwd,
      d1Bindings: ["DB"],
      migrations: { engine: "d1-sql", dir: "migrations" },
      configPath: path.join(cwd, ".everyapp", "wrangler.json"),
    });

    expect(mocks.executeCommandWithFormatting).not.toHaveBeenCalled();
  });

  it("uses Wrangler for local d1-sql migrations", async () => {
    const cwd = await makeTempDir();
    const wranglerBin = await installFakeWrangler(cwd);
    await fs.mkdir(path.join(cwd, "migrations"));
    const configPath = path.join(cwd, ".everyapp", "wrangler.json");

    await runLocalAppMigrations({
      cwd,
      d1Bindings: ["DB"],
      migrations: { engine: "d1-sql", dir: "migrations" },
      configPath,
    });

    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledWith(
      process.execPath,
      [
        wranglerBin,
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--persist-to",
        path.join(cwd, ".wrangler", "state"),
        "-c",
        configPath,
      ],
      expect.objectContaining({
        cwd,
        logCommandToConsole: false,
      }),
    );
  });
});

describe("d1DatabaseNameForBinding", () => {
  it("matches the deploy resource naming convention", () => {
    expect(d1DatabaseNameForBinding("every-todo", "DB")).toBe("every-todo");
    expect(d1DatabaseNameForBinding("every-todo", "USERS")).toBe(
      "every-todo-users",
    );
  });
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "everyapp-migrations-test-"));
}

async function installFakeWrangler(cwd: string): Promise<string> {
  return installFakePackageBin(cwd, "wrangler", "wrangler");
}

async function installFakePackageBin(
  cwd: string,
  packageName: string,
  binName: string,
): Promise<string> {
  const packageRoot = path.join(cwd, "node_modules", packageName);
  const binPath = path.join(packageRoot, "bin", `${binName}.js`);
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      bin: { [binName]: `bin/${binName}.js` },
    }),
    "utf-8",
  );
  await fs.writeFile(binPath, "", "utf-8");
  return fs.realpath(binPath);
}
