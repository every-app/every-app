import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claimOwner: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com" },
}));

vi.mock("@/server/services/SetupService", async () => {
  class SetupError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
    ) {
      super(code);
    }
  }
  return { SetupError, SetupService: { claimOwner: mocks.claimOwner } };
});

import { Route } from "@/routes/api/setup/claim";
import { SetupError } from "@/server/services/SetupService";

const handlers = (Route as any).options.server.handlers as {
  POST: (context: { request: Request }) => Promise<Response>;
};

const BODY = {
  token: "est_secret",
  name: "Ada",
  email: "ada@example.com",
  password: "correct horse battery",
};

function claimRequest(
  init: { headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request("https://gateway.example.com/api/setup/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://gateway.example.com",
      ...init.headers,
    },
    body: init.body ?? JSON.stringify(BODY),
  });
}

describe("POST /api/setup/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimOwner.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  it("claims the gateway and never caches the response", async () => {
    const response = await handlers.POST({ request: claimRequest() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      organizationId: "org-1",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.claimOwner).toHaveBeenCalledWith(BODY);
  });

  it("only declares POST, so other methods get 405", () => {
    expect(Object.keys(handlers)).toEqual(["POST"]);
  });

  it("rejects requests from another origin", async () => {
    for (const origin of ["https://todo.gateway.example.com", ""]) {
      const response = await handlers.POST({
        request: claimRequest({ headers: { origin } }),
      });
      expect(response.status).toBe(403);
    }
    expect(mocks.claimOwner).not.toHaveBeenCalled();
  });

  it("rejects non-JSON bodies (no form posts)", async () => {
    const response = await handlers.POST({
      request: claimRequest({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(BODY).toString(),
      }),
    });
    expect(response.status).toBe(415);
    expect(mocks.claimOwner).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const response = await handlers.POST({
      request: claimRequest({
        body: JSON.stringify({ ...BODY, password: "x" }),
      }),
    });
    expect(response.status).toBe(400);
    expect(mocks.claimOwner).not.toHaveBeenCalled();
  });

  it("maps a wrong, used or expired link to 403 and a claimed gateway to 409", async () => {
    const MockSetupError = SetupError as unknown as new (
      code: string,
      status: number,
    ) => Error;
    mocks.claimOwner
      .mockRejectedValueOnce(
        new MockSetupError("INVALID_OR_EXPIRED_SETUP_LINK", 403),
      )
      .mockRejectedValueOnce(new MockSetupError("ALREADY_CLAIMED", 409));

    const wrong = await handlers.POST({ request: claimRequest() });
    expect(wrong.status).toBe(403);
    await expect(wrong.json()).resolves.toMatchObject({
      error: "INVALID_OR_EXPIRED_SETUP_LINK",
    });

    const again = await handlers.POST({ request: claimRequest() });
    expect(again.status).toBe(409);
  });

  it("answers 503 CLAIM_IN_PROGRESS while another claim holds the setup lock", async () => {
    const MockSetupError = SetupError as unknown as new (
      code: string,
      status: number,
    ) => Error;
    mocks.claimOwner.mockRejectedValueOnce(
      new MockSetupError("CLAIM_IN_PROGRESS", 503),
    );

    const response = await handlers.POST({ request: claimRequest() });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "CLAIM_IN_PROGRESS",
    });
  });
});
