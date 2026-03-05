import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {
    CLOUDFLARE_ACCOUNT_ID: "account-123",
  },
}));

import { env } from "cloudflare:workers";
import { requireInternalCloudflareAuth } from "./internal-cloudflare-auth";

const testEnv = env as {
  CLOUDFLARE_ACCOUNT_ID?: string;
};

function authedRequest(token = "valid-cf-token"): Request {
  return new Request("https://gateway.example.com/internal", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function cloudflareApiResponse(
  success: boolean,
  result: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify({ success, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockSuccessfulCapabilityChecks() {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValueOnce(cloudflareApiResponse(true, {}))
    .mockResolvedValueOnce(
      cloudflareApiResponse(true, [
        { uuid: "db-123", name: "every-app-gateway" },
      ]),
    )
    .mockResolvedValueOnce(cloudflareApiResponse(true, []));
}

describe("requireInternalCloudflareAuth", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    testEnv.CLOUDFLARE_ACCOUNT_ID = "account-123";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 503 when CLOUDFLARE_ACCOUNT_ID is not configured", async () => {
    testEnv.CLOUDFLARE_ACCOUNT_ID = undefined;

    const response = await requireInternalCloudflareAuth(
      authedRequest("missing-account-token"),
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.response.status).toBe(503);
    }
  });

  it("requires bearer token in self-hosted mode", async () => {
    const response = await requireInternalCloudflareAuth(
      new Request("https://gateway.example.com/internal"),
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.response.status).toBe(401);
    }
  });

  it("returns ok when token and capability probes succeed", async () => {
    mockSuccessfulCapabilityChecks();

    const response = await requireInternalCloudflareAuth(
      authedRequest("happy-path-token"),
    );

    expect(response.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.cloudflare.com/client/v4/accounts/account-123/workers/scripts/every-app-gateway/settings",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects when d1 database lookup does not return an exact gateway DB name", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(cloudflareApiResponse(true, {}))
      .mockResolvedValueOnce(
        cloudflareApiResponse(true, [
          { uuid: "db-123", name: "some-other-db" },
        ]),
      );

    const response = await requireInternalCloudflareAuth(
      authedRequest("wrong-db-name-token"),
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.response.status).toBe(401);
    }
  });

  it("rejects when both capability probes fail", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(cloudflareApiResponse(false, {}, 403))
      .mockResolvedValueOnce(cloudflareApiResponse(false, {}, 403));

    const response = await requireInternalCloudflareAuth(
      authedRequest("capability-fail-token"),
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.response.status).toBe(401);
    }
  });

  it("rejects when worker read probe fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(cloudflareApiResponse(false, {}, 403))
      .mockResolvedValueOnce(
        cloudflareApiResponse(true, [
          { uuid: "db-123", name: "every-app-gateway" },
        ]),
      )
      .mockResolvedValueOnce(cloudflareApiResponse(true, []));

    const response = await requireInternalCloudflareAuth(
      authedRequest("worker-probe-fail-token"),
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.response.status).toBe(401);
    }
  });

  it("rejects when d1 write probe fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(cloudflareApiResponse(true, {}))
      .mockResolvedValueOnce(
        cloudflareApiResponse(true, [
          { uuid: "db-123", name: "every-app-gateway" },
        ]),
      )
      .mockResolvedValueOnce(cloudflareApiResponse(false, {}, 403));

    const response = await requireInternalCloudflareAuth(
      authedRequest("d1-probe-fail-token"),
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.response.status).toBe(401);
    }
  });

  it("returns 502 when Cloudflare API fetch throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS failed"));

    const response = await requireInternalCloudflareAuth(
      authedRequest("fetch-throws-token"),
    );

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.response.status).toBe(502);
    }
  });
});
