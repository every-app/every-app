import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDefaultAccountId: vi.fn(),
  getWorkersDevSubdomain: vi.fn(),
  makeCloudflareAPIRequest: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock("./auth", () => ({
  getDefaultAccountId: mocks.getDefaultAccountId,
  getWorkersDevSubdomain: mocks.getWorkersDevSubdomain,
  makeCloudflareAPIRequest: mocks.makeCloudflareAPIRequest,
}));

vi.mock("enquirer", () => ({
  default: { prompt: mocks.prompt },
}));

import { ensureWorkersDevSubdomain } from "./subdomain";

describe("ensureWorkersDevSubdomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDefaultAccountId.mockResolvedValue("account-1");
  });

  it("reuses an existing account subdomain", async () => {
    mocks.getWorkersDevSubdomain.mockResolvedValue("existing-subdomain");

    await expect(ensureWorkersDevSubdomain()).resolves.toBe(
      "existing-subdomain",
    );
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.makeCloudflareAPIRequest).not.toHaveBeenCalled();
  });

  it("prompts for and creates a missing account subdomain", async () => {
    mocks.getWorkersDevSubdomain.mockRejectedValue(
      new Error("No workers.dev subdomain found for this account"),
    );
    mocks.prompt.mockResolvedValue({ subdomain: "support-everyapp" });
    mocks.makeCloudflareAPIRequest.mockResolvedValue({
      subdomain: "support-everyapp",
    });

    await expect(ensureWorkersDevSubdomain()).resolves.toBe("support-everyapp");
    expect(mocks.makeCloudflareAPIRequest).toHaveBeenCalledWith(
      "/accounts/account-1/workers/subdomain",
      {
        method: "PUT",
        body: JSON.stringify({ subdomain: "support-everyapp" }),
      },
    );
  });
});
