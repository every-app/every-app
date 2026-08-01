import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareAPIError } from "./auth";
import {
  computeGatewayServiceBindings,
  replaceGatewayServiceBindings,
} from "./serviceBindings";

const makeCloudflareAPIRequest = vi.hoisted(() =>
  vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>(),
);
const getDefaultAccountId = vi.hoisted(() => vi.fn<() => Promise<string>>());
const listD1Databases = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cloudflare/auth", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getDefaultAccountId,
  makeCloudflareAPIRequest,
}));

vi.mock("@/lib/cloudflare/d1", () => ({
  listD1Databases,
}));

describe("computeGatewayServiceBindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultAccountId.mockResolvedValue("account-id");
    listD1Databases.mockResolvedValue([
      { name: "every-app-gateway", uuid: "database-id" },
    ]);
  });

  it("returns the full desired service binding list with APP__ prefixes", async () => {
    makeCloudflareAPIRequest.mockResolvedValueOnce({
      results: [
        { worker_name: "every-zebra" },
        { worker_name: "every-todo" },
        { worker_name: "every-todo" },
        { worker_name: null },
      ],
    });

    await expect(
      computeGatewayServiceBindings("account-id"),
    ).resolves.toEqual([
      { binding: "APP__every-todo", service: "every-todo" },
      { binding: "APP__every-zebra", service: "every-zebra" },
    ]);
  });

  it("returns no bindings when the registry table does not exist yet", async () => {
    makeCloudflareAPIRequest.mockRejectedValueOnce(
      new CloudflareAPIError({
        message: "Cloudflare API error: D1_ERROR: no such table: apps",
        status: 200,
        codes: [],
        endpoint: "/d1/query",
      }),
    );

    await expect(
      computeGatewayServiceBindings("account-id"),
    ).resolves.toEqual([]);
  });
});

describe("replaceGatewayServiceBindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listD1Databases.mockResolvedValue([
      { name: "every-app-gateway", uuid: "database-id" },
    ]);
  });

  it("keeps unrelated bindings and replaces only the managed service-binding set", async () => {
    makeCloudflareAPIRequest
      .mockResolvedValueOnce({
        bindings: [
          { name: "DB", type: "d1" },
          { name: "KV", type: "kv_namespace" },
          { name: "APP__stale", type: "service", service: "stale" },
          { name: "UNRELATED", type: "service", service: "other-worker" },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          { worker_name: "every-todo" },
          { worker_name: "every-notes" },
        ],
      })
      .mockResolvedValueOnce(undefined);

    await expect(
      replaceGatewayServiceBindings("account-id"),
    ).resolves.toEqual([
      { binding: "APP__every-notes", service: "every-notes" },
      { binding: "APP__every-todo", service: "every-todo" },
    ]);

    const patchCall = makeCloudflareAPIRequest.mock.calls.find(
      ([, options]) => options?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const patchBody = patchCall?.[1]?.body as FormData;
    expect(patchBody).toBeInstanceOf(FormData);
    expect(JSON.parse(String(patchBody.get("settings")))).toEqual({
      bindings: [
        { type: "inherit", name: "DB" },
        { type: "inherit", name: "KV" },
        { type: "inherit", name: "UNRELATED" },
        {
          type: "service",
          name: "APP__every-notes",
          service: "every-notes",
        },
        { type: "service", name: "APP__every-todo", service: "every-todo" },
      ],
    });

    const patchCalls = makeCloudflareAPIRequest.mock.calls.filter(
      ([, options]) => options?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);
  });

  it("inherits unrelated service bindings without reserializing their fields", async () => {
    makeCloudflareAPIRequest
      .mockResolvedValueOnce({
        bindings: [
          {
            name: "UNRELATED",
            type: "service",
            service: "other-worker",
            environment: "staging",
            entrypoint: "CustomEntrypoint",
          },
          {
            name: "APP__stale",
            type: "service",
            service: "stale-worker",
            environment: "production",
            entrypoint: "StaleEntrypoint",
          },
        ],
      })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce(undefined);

    await expect(
      replaceGatewayServiceBindings("account-id"),
    ).resolves.toEqual([]);

    const patchCall = makeCloudflareAPIRequest.mock.calls.find(
      ([, options]) => options?.method === "PATCH",
    );
    const patchBody = patchCall?.[1]?.body as FormData;
    expect(JSON.parse(String(patchBody.get("settings")))).toEqual({
      bindings: [{ type: "inherit", name: "UNRELATED" }],
    });
  });

  it("rejects non-service bindings in the reserved app namespace", async () => {
    makeCloudflareAPIRequest.mockResolvedValueOnce({
      bindings: [{ name: "APP__secret", type: "plain_text" }],
    });

    await expect(
      replaceGatewayServiceBindings("account-id"),
    ).rejects.toThrow(
      'Gateway binding "APP__secret" uses the reserved APP__ namespace but is not a service binding.',
    );
  });
});
