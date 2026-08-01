import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server", () => ({
  resolveAppByHostname: vi.fn(),
}));
import { resolveGrantedScopes, resolveResourceUrl } from "./oauth-consent";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

function authRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: "code",
    clientId: "client-1",
    redirectUri: "https://client.example.com/callback",
    scope: [],
    state: "state",
    resource: "https://todo.example.com/mcp",
    ...overrides,
  };
}

describe("oauth consent helpers", () => {
  it("rejects missing or non-https resource parameters", () => {
    expect(resolveResourceUrl(authRequest({ resource: undefined }))).toEqual({
      ok: false,
      message: "This authorization request didn't specify a valid app",
    });
    expect(
      resolveResourceUrl(authRequest({ resource: "http://x.test" })),
    ).toEqual({
      ok: false,
      message: "This authorization request didn't specify a valid app",
    });
  });

  it("resolves an https resource URL", () => {
    const resolved = resolveResourceUrl(authRequest());
    expect(resolved).toBeInstanceOf(URL);
    expect((resolved as URL).hostname).toBe("todo.example.com");
  });

  it("grants full internal access when the app declares no scopes or the request has none", () => {
    expect(resolveGrantedScopes([], { "mcp:read": "Read" })).toEqual({
      ok: true,
      scopes: ["*"],
      fullAccess: true,
    });
    expect(resolveGrantedScopes(["mcp:read"], undefined)).toEqual({
      ok: true,
      scopes: ["*"],
      fullAccess: true,
    });
  });

  it("intersects requested scopes with manifest-declared scopes", () => {
    expect(
      resolveGrantedScopes(["mcp:read", "mcp:admin"], { "mcp:read": "Read" }),
    ).toEqual({
      ok: true,
      scopes: ["mcp:read"],
      fullAccess: false,
    });
  });

  it("rejects reserved external scopes", () => {
    expect(resolveGrantedScopes(["*"], { "mcp:read": "Read" })).toEqual({
      ok: false,
      message: "This authorization request asked for unsupported scopes",
    });
    expect(
      resolveGrantedScopes(["provider:openai"], { "mcp:read": "Read" }),
    ).toEqual({
      ok: false,
      message: "This authorization request asked for unsupported scopes",
    });
  });
});
