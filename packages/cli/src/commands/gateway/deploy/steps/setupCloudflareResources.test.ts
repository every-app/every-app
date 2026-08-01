import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCloudflareResources } from "./setupCloudflareResources";

const mocks = vi.hoisted(() => ({
  getDefaultAccountId: vi.fn(),
  getOrCreateD1Database: vi.fn(),
  getOrCreateKVNamespace: vi.fn(),
}));

vi.mock("@/lib/cloudflare", () => ({
  getDefaultAccountId: mocks.getDefaultAccountId,
  getOrCreateD1Database: mocks.getOrCreateD1Database,
  getOrCreateKVNamespace: mocks.getOrCreateKVNamespace,
}));

describe("setupCloudflareResources", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.getDefaultAccountId.mockReset().mockResolvedValue("account-id");
    mocks.getOrCreateD1Database.mockReset().mockResolvedValue({
      id: "database-id",
      name: "every-app-gateway",
      wasCreated: false,
    });
    mocks.getOrCreateKVNamespace.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates both KV namespaces for a fresh account", async () => {
    mocks.getOrCreateKVNamespace
      .mockResolvedValueOnce({
        id: "kv-id",
        name: "every-app-gateway",
        wasCreated: true,
      })
      .mockResolvedValueOnce({
        id: "oauth-kv-id",
        name: "every-app-gateway-OAUTH_KV",
        wasCreated: true,
      });

    await expect(setupCloudflareResources()).resolves.toEqual({
      accountId: "account-id",
      d1DatabaseId: "database-id",
      kvNamespaceIds: {
        KV: "kv-id",
        OAUTH_KV: "oauth-kv-id",
      },
    });
    expect(mocks.getOrCreateKVNamespace.mock.calls).toEqual([
      ["every-app-gateway", "account-id"],
      ["every-app-gateway-OAUTH_KV", "account-id"],
    ]);
  });

});
