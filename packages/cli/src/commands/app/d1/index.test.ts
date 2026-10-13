import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createNdjsonSink } from "@/lib/output/events";
import { migrateLocal } from "./index";

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

describe("migrateLocal", () => {
  it("reports the applied migrations as NDJSON and exits 0", async () => {
    await fs.mkdir(path.join(cwd, "drizzle"));
    const { out, events } = ndjson();
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: '[{"name":"0000_init.sql","status":"✅"}]',
    });

    await migrateLocal({ cwd, out, local: true, cf });

    expect(events().map((event) => [event["type"], event["status"]])).toEqual([
      ["step", "start"],
      ["step", "ok"],
      ["done", undefined],
    ]);
    expect(events()[1]).toMatchObject({
      step: "migrations.local",
      data: { applied: ["0000_init.sql"] },
    });
    expect(out.exitCode).toBe(0);
  });

  it("skips an app without a migrations directory", async () => {
    const { out, events } = ndjson();
    await migrateLocal({ cwd, out, local: true, cf: new FakeCf() });

    expect(events()[1]).toMatchObject({
      type: "step",
      status: "skip",
      data: { reason: "no_migrations_dir" },
    });
    expect(out.exitCode).toBe(0);
  });

  it("emits an error and exits 1 when cf fails", async () => {
    await fs.mkdir(path.join(cwd, "drizzle"));
    const { out, events } = ndjson();
    const cf = new FakeCf().on(["d1"], {
      exitCode: 1,
      stderr: '┌ Error\n│ near "CREAT": syntax error\n└\n',
    });

    await migrateLocal({ cwd, out, local: true, cf });

    expect(events().at(-1)).toMatchObject({
      type: "error",
      code: "MIGRATIONS_FAILED",
      message: expect.stringContaining('near "CREAT": syntax error'),
    });
    expect(out.exitCode).toBe(1);
  });

  it("points remote migrations at app deploy", async () => {
    const { out, events } = ndjson();
    await migrateLocal({ cwd, out, local: false, cf: new FakeCf() });

    expect(events()).toEqual([
      expect.objectContaining({
        type: "error",
        code: "REMOTE_MIGRATIONS_UNSUPPORTED",
      }),
    ]);
    expect(out.exitCode).toBe(1);
  });
});
