/**
 * The OAuth server functions are the backstop behind the 404s on /oauth/*:
 * while MCP_OAUTH_ENABLED is off they must refuse without ever reaching the
 * OAuth provider, so no grant can be created, listed or revoked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const provider = {
    parseAuthRequest: vi.fn(),
    lookupClient: vi.fn(),
    completeAuthorization: vi.fn(),
    listUserGrants: vi.fn(),
    revokeGrant: vi.fn(),
  };
  const state = { flag: undefined as string | undefined, providerReads: 0 };
  return {
    provider,
    state,
    env: {
      get MCP_OAUTH_ENABLED() {
        return state.flag;
      },
      // Counts every touch of the binding, not just calls on it.
      get OAUTH_PROVIDER() {
        state.providerReads += 1;
        return provider;
      },
    },
    getSession: vi.fn(),
    getRequest: vi.fn(),
    resolveAuthorizeRequest: vi.fn(),
    buildAccessDeniedRedirect: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({ env: mocks.env }));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.middleware = vi.fn(() => builder);
    builder.validator = vi.fn(() => builder);
    builder.handler = vi.fn((handler: unknown) => {
      builder.serverHandler = handler;
      return builder;
    });
    return builder;
  }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => mocks.getRequest(),
}));

vi.mock("@/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("@/server/oauth-consent", () => ({
  resolveAuthorizeRequest: mocks.resolveAuthorizeRequest,
  buildAccessDeniedRedirect: mocks.buildAccessDeniedRedirect,
}));

vi.mock("@/middleware/auth", () => ({ organizationMemberMiddleware: {} }));
vi.mock("@/middleware/publicError", () => ({ publicErrorMiddleware: {} }));

import {
  approveAuthorization,
  denyAuthorization,
  getAuthorizeContext,
} from "./oauthAuthorization";
import { listMyOauthGrants, revokeMyOauthGrant } from "./oauthGrants";

type Handler = (input: {
  data?: unknown;
  context?: unknown;
}) => Promise<unknown>;
const handlerOf = (serverFn: unknown) =>
  (serverFn as { serverHandler: Handler }).serverHandler;

const USER = { id: "user-1", email: "ada@example.com" };
const QUERY = { query: "client_id=client-1&response_type=code" };

describe("OAuth server functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.flag = undefined;
    mocks.state.providerReads = 0;
    mocks.getRequest.mockReturnValue(
      new Request("https://gateway.example.com/_serverFn/abc"),
    );
    mocks.getSession.mockResolvedValue({ user: USER });
    mocks.provider.parseAuthRequest.mockResolvedValue({
      clientId: "client-1",
    });
    mocks.provider.lookupClient.mockResolvedValue({ clientId: "client-1" });
    mocks.provider.completeAuthorization.mockResolvedValue({
      redirectTo: "https://client.example/cb?code=x",
    });
    mocks.provider.listUserGrants.mockResolvedValue({
      items: [],
      cursor: undefined,
    });
    mocks.resolveAuthorizeRequest.mockResolvedValue({
      ok: true,
      request: { clientId: "client-1" },
      client: { clientId: "client-1", name: "Client" },
      app: {
        organizationId: "org-1",
        rowId: "app-row-1",
        appId: "todo",
        name: "Todo",
      },
      user: USER,
      scopes: ["todos:read"],
      fullAccess: false,
    });
    mocks.buildAccessDeniedRedirect.mockReturnValue(
      "https://client.example/cb?error=access_denied",
    );
  });

  describe("with MCP_OAUTH_ENABLED unset", () => {
    it("refuses the consent page's functions without touching the provider", async () => {
      await expect(handlerOf(getAuthorizeContext)({})).rejects.toThrow(
        "OAuth is not enabled",
      );
      await expect(
        handlerOf(approveAuthorization)({ data: QUERY }),
      ).rejects.toThrow("OAuth is not enabled");
      await expect(
        handlerOf(denyAuthorization)({ data: QUERY }),
      ).rejects.toThrow("OAuth is not enabled");

      expect(mocks.state.providerReads).toBe(0);
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.provider.completeAuthorization).not.toHaveBeenCalled();
    });

    it("lists no grants and revokes nothing", async () => {
      const context = { user: USER };
      await expect(handlerOf(listMyOauthGrants)({ context })).resolves.toEqual({
        enabled: false,
        grants: [],
        cursor: undefined,
      });
      await expect(
        handlerOf(revokeMyOauthGrant)({
          data: { grantId: "grant-1" },
          context,
        }),
      ).rejects.toMatchObject({ code: "OAUTH_DISABLED" });

      expect(mocks.state.providerReads).toBe(0);
      expect(mocks.provider.listUserGrants).not.toHaveBeenCalled();
      expect(mocks.provider.revokeGrant).not.toHaveBeenCalled();
    });

    it('treats anything but "true" as off', async () => {
      for (const flag of ["", "false", "1", "yes"]) {
        mocks.state.flag = flag;
        await expect(handlerOf(getAuthorizeContext)({})).rejects.toThrow(
          "OAuth is not enabled",
        );
      }
      expect(mocks.state.providerReads).toBe(0);
    });
  });

  describe('with MCP_OAUTH_ENABLED "true"', () => {
    beforeEach(() => {
      mocks.state.flag = "true";
    });

    it("runs the consent flow through the provider", async () => {
      await expect(handlerOf(getAuthorizeContext)({})).resolves.toMatchObject({
        ok: true,
        scopes: ["todos:read"],
      });
      await expect(
        handlerOf(approveAuthorization)({ data: QUERY }),
      ).resolves.toEqual({ redirectTo: "https://client.example/cb?code=x" });
      await expect(
        handlerOf(denyAuthorization)({ data: QUERY }),
      ).resolves.toEqual({
        redirectTo: "https://client.example/cb?error=access_denied",
      });

      expect(mocks.provider.completeAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER.id,
          props: expect.objectContaining({
            organizationId: "org-1",
            appRowId: "app-row-1",
          }),
        }),
      );
    });

    it("lists the user's grants", async () => {
      await expect(
        handlerOf(listMyOauthGrants)({ context: { user: USER } }),
      ).resolves.toMatchObject({ enabled: true, grants: [] });
      expect(mocks.provider.listUserGrants).toHaveBeenCalledWith(USER.id);
    });
  });
});
