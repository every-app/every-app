import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareAPIError } from "./auth";
import { getGatewayPublicUrl } from "./gatewayPublicUrl";

const getDefaultAccountId = vi.hoisted(() => vi.fn<() => Promise<string>>());
const getWorkerUrl = vi.hoisted(() =>
  vi.fn<(workerName: string, accountId?: string) => Promise<string>>(),
);
const makeCloudflareAPIRequest = vi.hoisted(() =>
  vi.fn<(endpoint: string) => Promise<unknown>>(),
);

vi.mock("@/lib/cloudflare/auth", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getDefaultAccountId,
  getWorkerUrl,
  makeCloudflareAPIRequest,
}));

describe("getGatewayPublicUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultAccountId.mockResolvedValue("account-id");
    getWorkerUrl.mockResolvedValue(
      "https://every-app-gateway.account.workers.dev",
    );
  });

  it("prefers the shortest custom domain attached to the gateway worker", async () => {
    makeCloudflareAPIRequest.mockResolvedValue([
      {
        hostname: "launch.example.com",
        service: "every-app-gateway",
      },
      {
        hostname: "example.com",
        service: "every-app-gateway",
      },
      {
        hostname: "other.example.com",
        service: "other-worker",
      },
    ]);

    await expect(getGatewayPublicUrl()).resolves.toBe("https://example.com");
    expect(makeCloudflareAPIRequest).toHaveBeenCalledWith(
      "/accounts/account-id/workers/domains?service=every-app-gateway&per_page=100",
    );
    expect(getWorkerUrl).not.toHaveBeenCalled();
  });

  it("falls back to the workers.dev URL when the domains endpoint is forbidden", async () => {
    makeCloudflareAPIRequest.mockRejectedValue(
      new CloudflareAPIError({
        message: "Cloudflare API request failed: 403 [10000] Authentication error",
        status: 403,
        codes: [10000],
        endpoint: "/domains",
      }),
    );

    await expect(getGatewayPublicUrl("explicit-account")).resolves.toBe(
      "https://every-app-gateway.account.workers.dev",
    );
    expect(getDefaultAccountId).not.toHaveBeenCalled();
    expect(getWorkerUrl).toHaveBeenCalledWith(
      "every-app-gateway",
      "explicit-account",
    );
  });
});
