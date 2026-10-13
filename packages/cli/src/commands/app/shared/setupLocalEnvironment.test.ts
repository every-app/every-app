import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { setupLocalEnvironment } from "./setupLocalEnvironment";

let targetDir: string;

beforeEach(async () => {
  targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-setup-local-"));
  await fs.mkdir(path.join(targetDir, "drizzle"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(targetDir, { recursive: true, force: true });
});

const manifest = { id: "todo", resources: { d1: ["DB"] } };

describe("setupLocalEnvironment", () => {
  it("writes .env.local, generates Worker types, then migrates the local D1", async () => {
    const cf = new FakeCf().on(["d1", "migrations", "apply"], {
      stdout: "[]",
    });

    await setupLocalEnvironment({
      targetDir,
      manifest,
      gatewayUrl: "https://apps.example.com",
      cf,
    });

    expect(
      await fs.readFile(path.join(targetDir, ".env.local"), "utf-8"),
    ).toContain("VITE_GATEWAY_URL=https://apps.example.com");
    expect(cf.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["workers", "types"],
      ["d1", "migrations", "apply"],
    ]);
    expect(cf.calls[0]).toMatchObject({ plane: "project", cwd: targetDir });
  });

  it("warns with the manual command instead of failing the setup", async () => {
    const cf = new FakeCf().on(["d1"], {
      exitCode: 1,
      stderr: "┌ Error\n│ no such table: todos\n└\n",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      setupLocalEnvironment({
        targetDir,
        manifest,
        gatewayUrl: "https://apps.example.com",
        cf,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("pnpm run db:migrate:local"),
    );
  });
});
