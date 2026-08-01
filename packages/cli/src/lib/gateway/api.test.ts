import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway/credentials", () => ({
  formatGatewayCredentialHelp: (gatewayUrl: string) =>
    `Open ${gatewayUrl}/admin/tokens, create a Deploy Token, then run everyapp login`,
  requireGatewayCredentialToken: vi.fn(),
}));

import { requireGatewayCredentialToken } from "@/lib/gateway/credentials";
import { GatewayClient } from "./api";

const mockRequireGatewayCredentialToken = vi.mocked(
  requireGatewayCredentialToken,
);

describe("GatewayClient deploy auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("sends stored eak token auth headers to deploy endpoints", async () => {
    mockRequireGatewayCredentialToken.mockResolvedValue("eak_stored");
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          organizationId: "org-123",
          organizationName: "Acme",
          scopes: ["apps:register", "apps:deploy"],
          capabilities: { appGateway: true },
        }),
        { status: 200 },
      ),
    );

    const client = new GatewayClient({
      gatewayUrl: "https://gateway.example.com/",
    });
    await expect(client.whoami()).resolves.toMatchObject({
      organizationId: "org-123",
      organizationName: "Acme",
      capabilities: { appGateway: true },
    });

    expect(mockRequireGatewayCredentialToken).toHaveBeenCalledWith(
      "https://gateway.example.com",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.example.com/api/deploy/whoami",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer eak_stored",
        }),
      }),
    );
  });

  it("surfaces missing stored credentials before making a request", async () => {
    mockRequireGatewayCredentialToken.mockRejectedValue(
      new Error("create a Deploy Token"),
    );

    const client = new GatewayClient({
      gatewayUrl: "https://gateway.example.com",
    });

    await expect(client.whoami()).rejects.toThrow("create a Deploy Token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes login guidance for rejected deploy tokens", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Invalid or expired deploy token" }),
        {
          status: 401,
        },
      ),
    );

    const client = new GatewayClient({
      gatewayUrl: "https://gateway.example.com",
      getAuthToken: async () => "eak_rejected",
    });

    await expect(client.whoami()).rejects.toMatchObject({
      name: "GatewayAuthError",
      message: expect.stringContaining("everyapp login"),
    });
  });
});
