import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfigAndDeploy } from "./updateConfigAndDeploy";

const mocks = vi.hoisted(() => ({
  executeCommandWithFormatting: vi.fn(),
  setupSecrets: vi.fn(),
  updateWranglerConfig: vi.fn(),
}));

vi.mock("@/lib/formatting", () => ({
  executeCommandWithFormatting: mocks.executeCommandWithFormatting,
}));

vi.mock("@/commands/gateway/deploy/setupSecrets", () => ({
  setupSecrets: mocks.setupSecrets,
}));

vi.mock("@/lib/wrangler-config", () => ({
  updateWranglerConfig: mocks.updateWranglerConfig,
}));

describe("updateConfigAndDeploy", () => {
  beforeEach(() => {
    mocks.executeCommandWithFormatting.mockReset();
    mocks.setupSecrets.mockReset();
    mocks.updateWranglerConfig.mockReset();
  });

  it("deploys with Wrangler resolved from the extracted gateway", async () => {
    const gatewayPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "everyapp-gateway-deploy-test-"),
    );
    const wranglerBin = await installFakeWrangler(gatewayPath);

    await updateConfigAndDeploy({
      gatewayPath,
      resources: {
        accountId: "account-id",
        d1DatabaseId: "database-id",
        kvNamespaceIds: {
          KV: "namespace-id",
          OAUTH_KV: "oauth-namespace-id",
        },
      },
      workerUrl: "https://gateway.example.workers.dev",
      verbose: false,
    });

    expect(mocks.updateWranglerConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        d1DatabaseId: "database-id",
        kvNamespaceIds: {
          KV: "namespace-id",
          OAUTH_KV: "oauth-namespace-id",
        },
      }),
    );
    expect(mocks.executeCommandWithFormatting).toHaveBeenCalledWith(
      process.execPath,
      [wranglerBin, "deploy"],
      expect.objectContaining({
        cwd: gatewayPath,
        env: expect.objectContaining({ BETTER_AUTH_SECRET: expect.any(String) }),
      }),
    );
    expect(mocks.setupSecrets).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPath }),
    );
  });
});

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
