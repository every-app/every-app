import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGatewayDatabaseId: vi.fn(),
  gatewayHasOwner: vi.fn(),
  mintSetupLink: vi.fn(),
  presentSetupLink: vi.fn(),
  exitWithUpdateNotice: vi.fn(),
}));

vi.mock("@/lib/cloudflare", () => ({
  requireCloudflareAuth: vi.fn(async () => undefined),
  getDefaultAccountId: vi.fn(async () => "account-id"),
  getGatewayPublicUrl: vi.fn(async () => "https://gateway.example.com"),
}));
vi.mock("@/lib/cloudflare/gatewayD1", () => ({
  findGatewayDatabaseId: mocks.findGatewayDatabaseId,
}));
vi.mock("@/lib/gateway/setup-link", () => ({
  gatewayHasOwner: mocks.gatewayHasOwner,
  mintSetupLink: mocks.mintSetupLink,
  presentSetupLink: mocks.presentSetupLink,
}));
vi.mock("@/lib/version-check", () => ({
  exitWithUpdateNotice: mocks.exitWithUpdateNotice,
}));

import type { LocalContext } from "@/context";
import { claimLink } from "./index";

const context = {} as LocalContext;

describe("everyapp gateway claim-link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.findGatewayDatabaseId.mockResolvedValue("database-id");
    mocks.gatewayHasOwner.mockResolvedValue(false);
    mocks.mintSetupLink.mockResolvedValue({
      url: "https://gateway.example.com/setup#token=est_x",
      expiresAt: new Date(),
    });
  });

  it("mints and presents a new link for an unclaimed gateway", async () => {
    await claimLink.call(context);

    expect(mocks.mintSetupLink).toHaveBeenCalledWith({
      accountId: "account-id",
      databaseId: "database-id",
      gatewayUrl: "https://gateway.example.com",
    });
    expect(mocks.presentSetupLink).toHaveBeenCalledOnce();
  });

  it("refuses once the gateway has an owner", async () => {
    mocks.gatewayHasOwner.mockResolvedValue(true);

    await claimLink.call(context);

    expect(mocks.mintSetupLink).not.toHaveBeenCalled();
    expect(mocks.exitWithUpdateNotice).toHaveBeenCalledWith(1);
  });

  it("explains when no gateway is deployed", async () => {
    mocks.findGatewayDatabaseId.mockResolvedValue(null);

    await claimLink.call(context);

    expect(mocks.gatewayHasOwner).not.toHaveBeenCalled();
    expect(mocks.exitWithUpdateNotice).toHaveBeenCalledWith(1);
  });
});
