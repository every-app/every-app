import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localD1Id } from "@every-app/sdk/cloudflare";
import { FakeCf } from "@/lib/cf/fakeCf";
import { EveryAppError } from "@/lib/errors";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { applyDevMigrations } from "./migrations";

const manifest = {
  id: "todo",
  resources: { d1: ["DB"] },
  migrations: { engine: "drizzle" as const },
};

let cwd: string;
let events: Array<Record<string, unknown>>;
let out: EventSink;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-dev-migrations-"));
  await fs.mkdir(path.join(cwd, "drizzle"));
  events = [];
  out = createNdjsonSink((line) => events.push(JSON.parse(line)));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("applyDevMigrations", () => {
  it("applies the migrations to the database cf dev serves", async () => {
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: '[{"name":"0000_init.sql","status":"✅"}]',
    });

    await applyDevMigrations({ cwd, manifest, cf, out, skip: false });

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
    expect(events.at(-1)).toMatchObject({
      type: "step",
      step: "dev.migrations",
      status: "ok",
      message: "Applied 0000_init.sql.",
      data: { applied: ["0000_init.sql"] },
    });
  });

  it("stops dev with an actionable error when migration fails", async () => {
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      exitCode: 1,
      stderr: "┌ Error\n│ migration 0001 failed\n└\n",
    });

    const failure = applyDevMigrations({ cwd, manifest, cf, out, skip: false });

    await expect(failure).rejects.toBeInstanceOf(EveryAppError);
    await expect(failure).rejects.toMatchObject({
      code: "MIGRATIONS_FAILED",
      message: expect.stringMatching(
        /^A local migration failed\n.*migration 0001 failed.*\nOr start with --skip-migrations if the local database is already usable\.$/s,
      ),
      data: { fix: expect.stringMatching(/^correct the migration, then run pnpm everyapp.* again$/) },
    });
    expect(events.at(-1)).toMatchObject({
      type: "step",
      step: "dev.migrations",
      status: "fail",
    });
  });

  it("starts no step for an app without a migrations directory or D1", async () => {
    await fs.rm(path.join(cwd, "drizzle"), { recursive: true });
    const cf = new FakeCf();

    await applyDevMigrations({ cwd, manifest, cf, out, skip: false });
    await applyDevMigrations({ cwd, manifest: { id: "todo" }, cf, out, skip: false });

    expect(cf.calls).toHaveLength(0);
    expect(events).toMatchObject([
      { status: "skip", data: { reason: "no_migrations_dir" } },
      { status: "skip", data: { reason: "no_d1" } },
    ]);
  });

  it("applies nothing with --skip-migrations", async () => {
    const cf = new FakeCf();

    await applyDevMigrations({ cwd, manifest, cf, out, skip: true });

    expect(cf.calls).toHaveLength(0);
    expect(events).toMatchObject([{ status: "skip", data: { reason: "flag" } }]);
  });
});
