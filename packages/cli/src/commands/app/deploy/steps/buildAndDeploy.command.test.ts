import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAndDeploy } from "./buildAndDeploy";

const mocks = vi.hoisted(() => ({
  executeCommandWithFormatting: vi.fn(),
}));

vi.mock("@/lib/formatting", () => ({
  executeCommandWithFormatting: mocks.executeCommandWithFormatting,
}));

vi.mock("@/lib/cloudflare/errors", () => ({
  formatCloudflareError: vi.fn(async () => null),
}));

vi.mock("@/lib/version-check", () => ({
  exitWithUpdateNotice: vi.fn(),
}));

describe("buildAndDeploy build command", () => {
  beforeEach(() => {
    mocks.executeCommandWithFormatting.mockReset();
  });

  it("auto-detects vite and builds with Every App env aliases", async () => {
    const cwd = await makeTempDir();
    await installFakeWrangler(cwd);
    await fs.writeFile(path.join(cwd, "vite.config.ts"), "export default {}");
    const generatedWranglerConfigPath = await writeGeneratedConfig(cwd);

    await buildAndDeploy({
      cwd,
      gatewayUrl: "https://gateway.example",
      appId: "todo",
      generatedWranglerConfigPath,
      verbose: false,
    });

    expect(mocks.executeCommandWithFormatting).toHaveBeenNthCalledWith(
      1,
      "npx",
      ["vite", "build"],
      expect.objectContaining({
        cwd,
        env: expect.objectContaining({
          VITE_GATEWAY_URL: "https://gateway.example",
          VITE_APP_ID: "todo",
          EVERYAPP_GATEWAY_URL: "https://gateway.example",
          EVERYAPP_APP_ID: "todo",
        }),
      }),
    );
  });

  it("runs a manifest-declared build command through the shell", async () => {
    const cwd = await makeTempDir();
    await installFakeWrangler(cwd);
    const generatedWranglerConfigPath = await writeGeneratedConfig(cwd);

    await buildAndDeploy({
      cwd,
      buildCommand: "yarn build && yarn postbuild",
      gatewayUrl: "https://gateway.example",
      appId: "todo",
      generatedWranglerConfigPath,
      verbose: false,
    });

    expect(mocks.executeCommandWithFormatting).toHaveBeenNthCalledWith(
      1,
      "yarn build && yarn postbuild",
      [],
      expect.objectContaining({ cwd, shell: true }),
    );
  });

  it("skips the build entirely for a plain worker (no vite, no command)", async () => {
    const cwd = await makeTempDir();
    const wranglerBin = await installFakeWrangler(cwd);
    const generatedWranglerConfigPath = await writeGeneratedConfig(cwd);

    await buildAndDeploy({
      cwd,
      gatewayUrl: "https://gateway.example",
      appId: "todo",
      generatedWranglerConfigPath,
      verbose: false,
    });

    // The only exec is the wrangler deploy itself.
    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledWith(
      process.execPath,
      [wranglerBin, "deploy", "-c", generatedWranglerConfigPath],
      expect.anything(),
    );
  });
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "everyapp-build-test-"));
}

async function writeGeneratedConfig(cwd: string): Promise<string> {
  const dir = path.join(cwd, ".everyapp");
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "wrangler.json");
  await fs.writeFile(configPath, "{}", "utf-8");
  return configPath;
}

async function installFakeWrangler(cwd: string): Promise<string> {
  const packageRoot = path.join(cwd, "node_modules", "wrangler");
  const binPath = path.join(packageRoot, "bin", "wrangler.js");
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "wrangler", bin: { wrangler: "bin/wrangler.js" } }),
    "utf-8",
  );
  await fs.writeFile(binPath, "", "utf-8");
  return fs.realpath(binPath);
}
