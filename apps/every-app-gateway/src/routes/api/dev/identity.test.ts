import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthenticate = vi.fn();

vi.mock("@/perimeter/betterAuthAuthenticator", () => ({
  createProdAuthenticator: () => ({
    authenticate: (...args: unknown[]) => mockAuthenticate(...args),
    hasAppAccess: vi.fn(),
  }),
}));

import { Route } from "./identity";

describe("dev identity route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the production authenticator's verified session", async () => {
    const verifiedSession = {
      sub: "user-1",
      email: "user@example.com",
      orgId: "org-1",
      orgRole: "owner",
    };
    mockAuthenticate.mockResolvedValue(verifiedSession);
    const request = new Request("http://localhost/api/dev/identity");

    const response = await getHandler()({ request });

    expect(mockAuthenticate).toHaveBeenCalledWith(request);
    await expect(response.json()).resolves.toEqual({
      session: verifiedSession,
      hasAccess: true,
      reason: null,
    });
  });

  it("fails closed when the production authenticator rejects the session", async () => {
    mockAuthenticate.mockResolvedValue(null);

    const response = await getHandler()({
      request: new Request("http://localhost/api/dev/identity"),
    });

    await expect(response.json()).resolves.toEqual({
      session: null,
      reason: "no_session",
    });
  });
});

function getHandler(): (input: { request: Request }) => Promise<Response> {
  return (Route as any).options.server.handlers.GET;
}
