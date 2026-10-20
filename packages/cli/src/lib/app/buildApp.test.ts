import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { buildApp } from "./buildApp";

const mocks = vi.hoisted(() => ({
  runLogged: vi.fn(),
}));

vi.mock("@/lib/childLog", () => ({
  runLogged: mocks.runLogged,
}));

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-build-app-"));
  mocks.runLogged.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("buildApp", () => {
  it("runs cf build with EVERYAPP_BUILD=1 and writes nothing into the app", async () => {
    const cf = new FakeCf().on(["build"], { stdout: "Build complete" });

    await buildApp({ cwd, cf, verbose: false });

    // Production is Vite's default mode; cf rejects --mode for TanStack Start.
    expect(cf.calls[0]).toMatchObject({
      args: ["build"],
      plane: "project",
      cwd,
      mode: "text",
      env: { EVERYAPP_BUILD: "1" },
    });
    // The build is tenant-neutral: no install's inputs, in a file or else.
    expect(await fs.readdir(cwd)).toEqual([]);
  });

  it("shows what the build printed last when it fails", async () => {
    const vite = Array.from({ length: 30 }, (_, i) => `vite line ${i + 1}`);
    const cf = new FakeCf().on(["build"], {
      exitCode: 1,
      stdout: vite.join("\n"),
      stderr: "error during build:\nError: boom\n",
    });

    const failure = await buildApp({ cwd, cf, verbose: false }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "BUILD_FAILED" });
    const lines = String((failure as Error).message).split("\n");
    expect(lines.slice(0, 2)).toEqual(["Build failed", "cf build's last lines:"]);
    expect(lines.slice(2)).toEqual(
      [...vite.slice(-18), "error during build:", "Error: boom"].map((line) => `  ${line}`),
    );
  });

  it("runs the manifest's build command instead of cf build, with EVERYAPP_BUILD=1", async () => {
    const cf = new FakeCf();

    await buildApp({
      cwd,
      cf,
      buildCommand: "pnpm run build:prod",
      verbose: false,
    });

    expect(cf.calls).toHaveLength(0);
    expect(mocks.runLogged).toHaveBeenCalledWith(
      "pnpm run build:prod",
      [],
      expect.objectContaining({
        cwd,
        shell: true,
        env: expect.objectContaining({ EVERYAPP_BUILD: "1" }),
      }),
    );
  });
});
