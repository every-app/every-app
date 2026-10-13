import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ retrieveDeployToken: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com" },
}));

vi.mock("@/server/services/SetupService", () => ({
  SetupService: { retrieveDeployToken: mocks.retrieveDeployToken },
}));

import { Route } from "@/routes/api/setup/deploy-token";

const handlers = (Route as any).options.server.handlers as {
  POST: (context: { request: Request }) => Promise<Response>;
};

function retrieval(
  init: { headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request("https://gateway.example.com/api/setup/deploy-token", {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body ?? JSON.stringify({ cliSecret: "ecs_secret" }),
  });
}

describe("POST /api/setup/deploy-token", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands over the token and who claimed the link once it is claimed, never cached", async () => {
    mocks.retrieveDeployToken.mockResolvedValue({
      status: "issued",
      token: "eak_token",
      organizationId: "org-1",
      organizationName: "Acme",
      ownerEmail: "owner@example.com",
    });

    const response = await handlers.POST({ request: retrieval() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "eak_token",
      organizationId: "org-1",
      organizationName: "Acme",
      ownerEmail: "owner@example.com",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.retrieveDeployToken).toHaveBeenCalledWith("ecs_secret");
  });

  it("says to keep waiting before the claim, and 404s anything else", async () => {
    mocks.retrieveDeployToken
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "invalid" });

    const pending = await handlers.POST({ request: retrieval() });
    expect(pending.status).toBe(202);
    await expect(pending.json()).resolves.toEqual({ status: "pending" });

    const invalid = await handlers.POST({ request: retrieval() });
    expect(invalid.status).toBe(404);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "INVALID_OR_EXPIRED_SETUP_LINK",
    });
  });

  it("only declares POST, and takes JSON alone", async () => {
    expect(Object.keys(handlers)).toEqual(["POST"]);
    const form = await handlers.POST({
      request: retrieval({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "cliSecret=ecs_secret",
      }),
    });
    expect(form.status).toBe(415);
    const empty = await handlers.POST({
      request: retrieval({ body: JSON.stringify({}) }),
    });
    expect(empty.status).toBe(400);
    expect(mocks.retrieveDeployToken).not.toHaveBeenCalled();
  });
});
