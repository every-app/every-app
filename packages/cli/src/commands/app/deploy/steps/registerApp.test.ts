import { beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  whoami: vi.fn(),
  registerApp: vi.fn(),
}));

vi.mock("@/lib/gateway/api", () => ({
  GatewayClient: class {
    whoami = gateway.whoami;
    registerApp = gateway.registerApp;
  },
  isGatewayAuthError: () => false,
  isGatewayInternalApisDisabledError: () => false,
  isOutdatedGatewayError: () => false,
}));

vi.mock("@/lib/version-check", () => ({
  exitWithUpdateNotice: vi.fn(),
}));

import {
  registerAppWithGateway,
  resolveGatewayDeploymentInfo,
} from "./registerApp";
import { generateWranglerConfig } from "@/lib/generateWranglerConfig";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gateway registration ordering", () => {
  it("enables the binding when the gateway advertises AppGateway", async () => {
    gateway.whoami.mockResolvedValue({
      organizationId: "org-123",
      capabilities: { appGateway: true },
    });

    const deployment = await resolveGatewayDeploymentInfo(
      "https://gateway.example.com",
    );
    expect(deployment).toEqual({
      organizationId: "org-123",
      gatewayBinding: { organizationId: "org-123" },
    });
    expect(
      generateWranglerConfig(
        { id: "chef" },
        { gatewayBinding: deployment.gatewayBinding },
      ).services,
    ).toEqual([
      expect.objectContaining({
        binding: "EVERY_APP_GATEWAY",
        entrypoint: "AppGateway",
      }),
    ]);
    expect(gateway.whoami).toHaveBeenCalledTimes(1);
  });

  it("omits the binding and explains the upgrade for an older gateway", async () => {
    gateway.whoami.mockResolvedValue({ organizationId: "org-123" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deployment = await resolveGatewayDeploymentInfo(
      "https://gateway.example.com",
    );
    expect(deployment).toEqual({ organizationId: "org-123" });
    expect(
      generateWranglerConfig(
        { id: "chef" },
        { gatewayBinding: deployment.gatewayBinding },
      ),
    ).not.toHaveProperty("services");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Upgrade your gateway to enable the AI proxy binding",
      ),
    );
  });

  it("registers after deploy without resolving a second organization", async () => {
    gateway.registerApp.mockResolvedValue({
      appSlug: "chef",
      hostname: "chef-acme.example.com",
      existingApp: false,
      defaultAccess: true,
      grantedUserCount: 1,
    });

    await expect(
      registerAppWithGateway({
        appId: "chef",
        workerName: "every-chef",
        manifest: { id: "chef", providers: ["openai"] },
        gatewayUrl: "https://gateway.example.com",
      }),
    ).resolves.toEqual({ hostname: "chef-acme.example.com" });
    expect(gateway.whoami).not.toHaveBeenCalled();
    expect(gateway.registerApp).toHaveBeenCalledWith({
      appId: "chef",
      name: "chef",
      description: "chef",
      workerName: "every-chef",
      manifest: { id: "chef", providers: ["openai"] },
    });
  });
});
