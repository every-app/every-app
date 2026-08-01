import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAndDeploy } from "./buildAndDeploy";

const executeCommandWithFormatting = vi.hoisted(() => vi.fn());

vi.mock("@/lib/formatting", () => ({
  executeCommandWithFormatting,
}));

vi.mock("@/lib/cloudflare/errors", () => ({
  formatCloudflareError: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/version-check", () => ({
  exitWithUpdateNotice: vi.fn(),
}));

describe("buildAndDeploy", () => {
  it("patches the built config private before deploying it", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-build-"));
    try {
      const wranglerBin = await installFakeWrangler(tmpDir);
      const builtConfigPath = path.join(
        tmpDir,
        "dist",
        "server",
        "wrangler.json",
      );
      const generatedConfigPath = path.join(
        tmpDir,
        ".everyapp",
        "wrangler.json",
      );
      await fs.mkdir(path.dirname(builtConfigPath), { recursive: true });
      await fs.mkdir(path.dirname(generatedConfigPath), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "vite.config.ts"), "", "utf-8");
      await fs.writeFile(
        generatedConfigPath,
        [
          "// generated from everyapp.config.ts — do not edit",
          JSON.stringify({
            name: "every-todo",
            vars: {
              EVERYAPP_IDENTITY_ISSUER: "https://gateway.example.com",
              EVERYAPP_IDENTITY_PUBLIC_KEYS: '["pem"]',
            },
            services: [
              {
                binding: "EVERY_APP_GATEWAY",
                service: "every-app-gateway",
                entrypoint: "AppGateway",
                props: {
                  organizationId: "org-1",
                  appId: "todo",
                  workerName: "every-todo",
                },
              },
            ],
          }),
        ].join("\n"),
        "utf-8",
      );
      executeCommandWithFormatting.mockImplementation(
        async (cmd: string, args: string[]) => {
          if (cmd === "npx" && args[0] === "vite") {
            await fs.writeFile(
              builtConfigPath,
              JSON.stringify(
                {
                  name: "todo",
                  topLevelName: "todo",
                  main: "index.js",
                  configPath: "/app/.everyapp/wrangler.json",
                  userConfigPath: "/app/.everyapp/wrangler.json",
                  routes: [
                    { pattern: "todo.example.com", custom_domain: true },
                  ],
                  vars: { DOMAINS: "example.com" },
                  services: [
                    { binding: "MY_OWN", service: "some-other-worker" },
                  ],
                },
                null,
                2,
              ),
              "utf-8",
            );
          }
        },
      );

      await buildAndDeploy({
        cwd: tmpDir,
        gatewayUrl: "https://gateway.example.com",
        appId: "todo",
        generatedWranglerConfigPath: generatedConfigPath,
        verbose: false,
      });

      const updated = JSON.parse(await fs.readFile(builtConfigPath, "utf-8"));
      expect(updated).not.toHaveProperty("configPath");
      expect(updated).not.toHaveProperty("userConfigPath");
      expect(updated).not.toHaveProperty("routes");
      expect(updated.name).toBe("every-todo");
      expect(updated.topLevelName).toBe("every-todo");
      expect(updated.workers_dev).toBe(false);
      expect(updated.preview_urls).toBe(false);
      expect(updated.vars).toEqual({
        DOMAINS: "example.com",
        EVERYAPP_IDENTITY_ISSUER: "https://gateway.example.com",
        EVERYAPP_IDENTITY_PUBLIC_KEYS: '["pem"]',
      });
      // Unrelated built binding preserved; gateway binding grafted from generated.
      expect(updated.services).toEqual([
        { binding: "MY_OWN", service: "some-other-worker" },
        {
          binding: "EVERY_APP_GATEWAY",
          service: "every-app-gateway",
          entrypoint: "AppGateway",
          props: {
            organizationId: "org-1",
            appId: "todo",
            workerName: "every-todo",
          },
        },
      ]);
      expect(executeCommandWithFormatting).toHaveBeenLastCalledWith(
        process.execPath,
        [wranglerBin, "deploy", "-c", builtConfigPath],
        expect.objectContaining({
          cwd: tmpDir,
          env: expect.objectContaining({
            VITE_APP_ID: "todo",
            VITE_GATEWAY_URL: "https://gateway.example.com",
          }),
        }),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      executeCommandWithFormatting.mockReset();
    }
  });

  it("aborts the deploy when the generated config lacks identity vars", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-build-"));
    try {
      await installFakeWrangler(tmpDir);
      const builtConfigPath = path.join(
        tmpDir,
        "dist",
        "server",
        "wrangler.json",
      );
      const generatedConfigPath = path.join(
        tmpDir,
        ".everyapp",
        "wrangler.json",
      );
      await fs.mkdir(path.dirname(builtConfigPath), { recursive: true });
      await fs.mkdir(path.dirname(generatedConfigPath), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "vite.config.ts"), "", "utf-8");
      await fs.writeFile(
        generatedConfigPath,
        JSON.stringify({ name: "every-todo", vars: {} }),
        "utf-8",
      );
      executeCommandWithFormatting.mockImplementation(
        async (cmd: string, args: string[]) => {
          if (cmd === "npx" && args[0] === "vite") {
            await fs.writeFile(
              builtConfigPath,
              JSON.stringify({ name: "todo", main: "index.js" }),
              "utf-8",
            );
          }
        },
      );

      await expect(
        buildAndDeploy({
          cwd: tmpDir,
          gatewayUrl: "https://gateway.example.com",
          appId: "todo",
          generatedWranglerConfigPath: generatedConfigPath,
          verbose: false,
        }),
      ).rejects.toThrow(/EVERYAPP_IDENTITY_PUBLIC_KEYS/);
      const deployCalls = executeCommandWithFormatting.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args.includes("deploy"),
      );
      expect(deployCalls).toHaveLength(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      executeCommandWithFormatting.mockReset();
    }
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
