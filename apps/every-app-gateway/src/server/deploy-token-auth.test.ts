import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  },
}));

vi.mock("@/server/services/AppTokenService", () => ({
  AppTokenService: {
    verifyDeployToken: vi.fn(),
  },
}));

import { env } from "cloudflare:workers";
import { AppTokenService } from "@/server/services/AppTokenService";
import { requireDeployTokenAuth } from "./deploy-token-auth";

const mockAppTokenService = vi.mocked(AppTokenService);

function request(token?: string): Request {
  return new Request("https://gateway.example.com/api/deploy/whoami", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe("deploy token auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
  });

  it("rejects hosted mode with the internal-disabled error code", async () => {
    env.GATEWAY_DEPLOYMENT_MODE = "hosted";

    const result = await requireDeployTokenAuth(request("eak_valid"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      await expect(result.response.json()).resolves.toMatchObject({
        code: "INTERNAL_APIS_DISABLED",
      });
    }
  });

  it("rejects missing bearer tokens", async () => {
    const result = await requireDeployTokenAuth(request());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns deploy context for valid eak tokens", async () => {
    mockAppTokenService.verifyDeployToken.mockResolvedValue({
      organizationId: "org-123",
      scopes: ["apps:register", "apps:deploy"],
    });

    const result = await requireDeployTokenAuth(request("eak_valid"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context).toEqual({
        organizationId: "org-123",
        scopes: ["apps:register", "apps:deploy"],
      });
    }
    expect(mockAppTokenService.verifyDeployToken).toHaveBeenCalledWith(
      "eak_valid",
    );
  });
});
