import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_INPUTS_FILE } from "@every-app/sdk/cloudflare";
import { CfError } from "@/lib/cf/errors";
import { FakeCf } from "@/lib/cf/fakeCf";
import { buildApp } from "./buildApp";
import { writeDeployInputs, type DeployInputs } from "./deployInputs";

const mocks = vi.hoisted(() => ({
  executeCommandWithFormatting: vi.fn(),
}));

vi.mock("@/lib/formatting", () => ({
  executeCommandWithFormatting: mocks.executeCommandWithFormatting,
}));

const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----\n";

const inputs: DeployInputs = {
  workerName: "every-todo",
  organizationId: "org_1",
  gatewayUrl: "https://apps.example.com",
  identityIssuer: "https://apps.example.com",
  identityPublicKeys: [PUBLIC_KEY],
  resources: { d1: { DB: { name: "every-todo", id: "d1-uuid" } } },
};

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-build-app-"));
  mocks.executeCommandWithFormatting.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

const deployInputsPath = () => path.join(cwd, DEPLOY_INPUTS_FILE);

describe("buildApp", () => {
  it("runs cf build with deploy.json present, then removes it", async () => {
    let sawDeployInputs = false;
    const cf = new FakeCf().on(
      (args) => {
        sawDeployInputs = existsSync(deployInputsPath());
        return args[0] === "build";
      },
      { stdout: "Build complete" },
    );

    await buildApp({
      cwd,
      cf,
      inputs,
      env: { VITE_APP_ID: "todo" },
      verbose: false,
    });

    expect(sawDeployInputs).toBe(true);
    // Production is Vite's default mode; cf rejects --mode for TanStack Start.
    expect(cf.calls[0]).toMatchObject({
      args: ["build"],
      plane: "project",
      cwd,
      mode: "text",
      env: { VITE_APP_ID: "todo" },
    });
    expect(existsSync(deployInputsPath())).toBe(false);
  });

  it("removes deploy.json when the build fails", async () => {
    const cf = new FakeCf().on(["build"], {
      exitCode: 1,
      stderr: "error during build:\nError: boom\n",
    });

    await expect(
      buildApp({ cwd, cf, inputs, env: {}, verbose: false }),
    ).rejects.toBeInstanceOf(CfError);
    expect(existsSync(deployInputsPath())).toBe(false);
  });

  it("runs the manifest's build command instead of cf build", async () => {
    const cf = new FakeCf();
    mocks.executeCommandWithFormatting.mockImplementation(async () => {
      expect(existsSync(deployInputsPath())).toBe(true);
    });

    await buildApp({
      cwd,
      cf,
      inputs,
      buildCommand: "pnpm run build:prod",
      env: { VITE_APP_ID: "todo" },
      verbose: false,
    });

    expect(cf.calls).toHaveLength(0);
    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledWith(
      "pnpm run build:prod",
      [],
      expect.objectContaining({
        cwd,
        shell: true,
        env: expect.objectContaining({ VITE_APP_ID: "todo" }),
      }),
    );
    expect(existsSync(deployInputsPath())).toBe(false);
  });
});

describe("writeDeployInputs", () => {
  it("writes the SDK's schema privately and keeps .everyapp ignored", async () => {
    const file = await writeDeployInputs(cwd, inputs);

    expect(file).toBe(deployInputsPath());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      schema: 1,
      workerName: "every-todo",
      createdAt: expect.any(String),
    });
    expect(await fs.readFile(path.join(cwd, ".gitignore"), "utf-8")).toContain(
      ".everyapp/",
    );
  });

  it("refuses inputs the app's config could not read", async () => {
    await expect(
      writeDeployInputs(cwd, { ...inputs, identityPublicKeys: [] }),
    ).rejects.toThrow(/identityPublicKeys/);
    expect(existsSync(deployInputsPath())).toBe(false);
  });
});
