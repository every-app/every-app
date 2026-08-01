import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as jsonc from "jsonc-parser";
import { updateWranglerConfig } from "./wrangler-config";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wrangler-config-"));
  configPath = path.join(dir, "wrangler.jsonc");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(config: unknown): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

async function readConfig(): Promise<{
  kv_namespaces?: Array<{ binding: string; id: string }>;
}> {
  return jsonc.parse(await readFile(configPath, "utf-8"));
}

describe("updateWranglerConfig KV handling", () => {
  it("injects provisioned ids by binding name", async () => {
    await writeConfig({
      kv_namespaces: [
        { binding: "KV", id: "placeholder" },
        { binding: "OAUTH_KV", id: "oauth-placeholder" },
      ],
    });

    await updateWranglerConfig({
      configPath,
      kvNamespaceIds: {
        KV: "provisioned-id",
        OAUTH_KV: "provisioned-oauth-id",
      },
    });

    const kv = (await readConfig()).kv_namespaces ?? [];
    expect(kv).toContainEqual({ binding: "KV", id: "provisioned-id" });
    expect(kv).toContainEqual({
      binding: "OAUTH_KV",
      id: "provisioned-oauth-id",
    });
  });

  it("targets each KV by binding name regardless of order", async () => {
    await writeConfig({
      kv_namespaces: [
        { binding: "OAUTH_KV", id: "oauth-placeholder" },
        { binding: "KV", id: "placeholder" },
      ],
    });

    await updateWranglerConfig({
      configPath,
      kvNamespaceIds: {
        KV: "provisioned-id",
        OAUTH_KV: "provisioned-oauth-id",
      },
    });

    const kv = (await readConfig()).kv_namespaces ?? [];
    expect(kv).toContainEqual({
      binding: "OAUTH_KV",
      id: "provisioned-oauth-id",
    });
    expect(kv).toContainEqual({ binding: "KV", id: "provisioned-id" });
  });

  it("rejects a config with an unknown extra KV binding", async () => {
    await writeConfig({
      kv_namespaces: [
        { binding: "KV", id: "placeholder" },
        { binding: "OAUTH_KV", id: "oauth-placeholder" },
        { binding: "EXTRA_KV", id: "foreign-account-id" },
      ],
    });

    await expect(
      updateWranglerConfig({
        configPath,
        kvNamespaceIds: {
          KV: "provisioned-id",
          OAUTH_KV: "provisioned-oauth-id",
        },
      }),
    ).rejects.toThrow(
      'Wrangler config declares KV binding "EXTRA_KV", but the CLI did not provision it.',
    );
  });

  it("rejects an unprovisioned KV binding named after an Object.prototype member", async () => {
    // A truthy lookup on the provisioned map resolves `constructor` through the
    // prototype chain, so this binding would pass validation and keep its
    // original (foreign-account) id instead of failing loudly.
    await writeConfig({
      kv_namespaces: [
        { binding: "KV", id: "placeholder" },
        { binding: "OAUTH_KV", id: "oauth-placeholder" },
        { binding: "constructor", id: "foreign-account-id" },
      ],
    });

    await expect(
      updateWranglerConfig({
        configPath,
        kvNamespaceIds: {
          KV: "provisioned-id",
          OAUTH_KV: "provisioned-oauth-id",
        },
      }),
    ).rejects.toThrow(
      'Wrangler config declares KV binding "constructor", but the CLI did not provision it.',
    );
  });

  it("rejects a config missing a provisioned KV binding", async () => {
    await writeConfig({
      kv_namespaces: [{ binding: "KV", id: "placeholder" }],
    });

    await expect(
      updateWranglerConfig({
        configPath,
        kvNamespaceIds: {
          KV: "provisioned-id",
          OAUTH_KV: "provisioned-oauth-id",
        },
      }),
    ).rejects.toThrow(
      'The CLI provisioned KV binding "OAUTH_KV", but Wrangler config does not declare it.',
    );
  });

  it("rejects a config with more than one namespace for a binding", async () => {
    await writeConfig({
      kv_namespaces: [
        { binding: "KV", id: "a" },
        { binding: "KV", id: "b" },
        { binding: "OAUTH_KV", id: "oauth-placeholder" },
      ],
    });

    await expect(
      updateWranglerConfig({
        configPath,
        kvNamespaceIds: {
          KV: "provisioned-id",
          OAUTH_KV: "provisioned-oauth-id",
        },
      }),
    ).rejects.toThrow(/Found 2 KV namespaces bound to "KV"/);
  });
});

describe("updateWranglerConfig placeholder handling", () => {
  it("rejects unresolved CLI placeholders after patching", async () => {
    await writeConfig({
      name: "CLI_PATCHES_WORKER_NAME",
      vars: {
        FUTURE_SETTING: "CLI_PATCHES_FUTURE_SETTING",
      },
    });

    await expect(
      updateWranglerConfig({
        configPath,
        name: "patched-worker",
      }),
    ).rejects.toThrow(
      'Wrangler config still contains unresolved placeholder "CLI_PATCHES_FUTURE_SETTING" after CLI patching.',
    );
  });
});
