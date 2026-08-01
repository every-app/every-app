import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretExists } from "./secrets";

const getDefaultAccountId = vi.hoisted(() => vi.fn<() => Promise<string>>());
const makeCloudflareAPIRequest = vi.hoisted(() =>
  vi.fn<(endpoint: string) => Promise<Array<{ name: string; type: string }>>>(),
);
const loadEveryAppManifest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cloudflare/auth", () => ({
  getDefaultAccountId,
  makeCloudflareAPIRequest,
}));

vi.mock("@/lib/generateWranglerConfig", () => ({
  loadEveryAppManifest,
}));

describe("secret helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultAccountId.mockResolvedValue("account-id");
    makeCloudflareAPIRequest.mockResolvedValue([]);
  });

  it("uses an explicit worker name instead of reading the manifest", async () => {
    await secretExists({
      cwd: "/app-without-wrangler",
      workerName: "every-todo",
      secretName: "GATEWAY_URL",
    });

    expect(loadEveryAppManifest).not.toHaveBeenCalled();
    expect(makeCloudflareAPIRequest).toHaveBeenCalledWith(
      "/accounts/account-id/workers/scripts/every-todo/secrets",
    );
  });
});
