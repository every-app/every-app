import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareAPIError,
  isCloudflareAuthError,
  makeCloudflareAPIRequest,
} from "./auth";

describe("makeCloudflareAPIRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("throws CloudflareAPIError with status, codes, and endpoint on non-2xx responses", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
            messages: [],
            result: null,
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      makeCloudflareAPIRequest("/accounts/account-id/workers/scripts/foo"),
    ).rejects.toMatchObject({
      status: 403,
      codes: [10000],
      endpoint: "/accounts/account-id/workers/scripts/foo",
      message:
        "Cloudflare API request failed: 403 [10000] Authentication error",
    });

    await expect(
      makeCloudflareAPIRequest("/accounts/account-id/workers/scripts/foo"),
    ).rejects.toBeInstanceOf(CloudflareAPIError);
  });

  it("throws CloudflareAPIError when the response is 2xx but success is false", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          success: false,
          errors: [{ code: 10042, message: "R2 not enabled" }],
          messages: [],
          result: null,
        }),
      ),
    );

    await expect(makeCloudflareAPIRequest("/r2")).rejects.toMatchObject({
      status: 200,
      codes: [10042],
      endpoint: "/r2",
      message: "Cloudflare API error: [10042] R2 not enabled",
    });
  });
});

describe("isCloudflareAuthError", () => {
  it("matches typed auth failures by status or Cloudflare code", () => {
    expect(
      isCloudflareAuthError(
        new CloudflareAPIError({
          message: "forbidden",
          status: 403,
          codes: [],
          endpoint: "/test",
        }),
      ),
    ).toBe(true);
    expect(
      isCloudflareAuthError(
        new CloudflareAPIError({
          message: "auth code",
          status: 400,
          codes: [10000],
          endpoint: "/test",
        }),
      ),
    ).toBe(true);
  });
});
