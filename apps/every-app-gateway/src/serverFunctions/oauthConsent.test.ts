/**
 * The consent page's server function: the backstop behind the 404s on
 * /oauth/* while MCP_OAUTH_ENABLED is off, and a context built from the
 * authorization request the page carries, never from the function's own URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  getSession: vi.fn(),
  getRequest: vi.fn(),
  refreshMcpAuth: vi.fn(),
  buildConsentContext: vi.fn(),
}));

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
vi.mock("@/middleware/publicError", () => ({ publicErrorMiddleware: {} }));
vi.mock("@/server/mcp-auth/config", () => ({
  refreshMcpAuth: mocks.refreshMcpAuth,
}));
vi.mock("@/server/mcp-auth/consent", () => ({
  buildConsentContext: mocks.buildConsentContext,
}));

import { getConsentContext } from "./oauthConsent";

const handler = (
  getConsentContext as unknown as {
    serverHandler: (input: { data: { query: string } }) => Promise<unknown>;
  }
).serverHandler;

const QUERY = "?client_id=client-1&response_type=code&handle=h1";
const MCP_AUTH = { issuer: "https://gateway.example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.env)) delete mocks.env[key];
  mocks.getRequest.mockReturnValue(
    new Request("https://gateway.example.com/_serverFn/abc?evil=1"),
  );
  mocks.refreshMcpAuth.mockResolvedValue(MCP_AUTH);
  mocks.getSession.mockResolvedValue({
    user: { id: "user-1", email: "ada@example.com" },
    session: { activeOrganizationId: "org-1" },
  });
  mocks.buildConsentContext.mockResolvedValue({ ok: true });
});

describe("getConsentContext", () => {
  it("refuses while OAuth is off, without reading the session", async () => {
    mocks.env["MCP_OAUTH_ENABLED"] = "false";
    await expect(handler({ data: { query: QUERY } })).rejects.toMatchObject({
      code: "OAUTH_DISABLED",
    });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.buildConsentContext).not.toHaveBeenCalled();
  });

  it("refuses when GATEWAY_URL can't be an OAuth issuer", async () => {
    mocks.refreshMcpAuth.mockResolvedValue(null);
    await expect(handler({ data: { query: QUERY } })).rejects.toMatchObject({
      code: "OAUTH_DISABLED",
    });
  });

  it("tells a signed-out page to sign in", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(handler({ data: { query: QUERY } })).resolves.toEqual({
      ok: false,
      signedOut: true,
    });
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", email: "a@example.com", banned: true },
      session: {},
    });
    await expect(handler({ data: { query: QUERY } })).resolves.toEqual({
      ok: false,
      signedOut: true,
    });
    expect(mocks.buildConsentContext).not.toHaveBeenCalled();
  });

  it("builds the context from the page's query, not the function's URL", async () => {
    await expect(handler({ data: { query: QUERY } })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.buildConsentContext).toHaveBeenCalledWith(
      MCP_AUTH,
      mocks.env,
      QUERY,
      { id: "user-1", email: "ada@example.com", activeOrganizationId: "org-1" },
    );
  });

  it("builds the servers with the resource the page names, so a fresh isolate knows a native app's host", async () => {
    const native = `${QUERY}&resource=${encodeURIComponent("https://todo.example.com")}`;
    await expect(handler({ data: { query: native } })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.refreshMcpAuth).toHaveBeenCalledWith(
      mocks.env,
      "https://todo.example.com",
    );
    // An MCP request names no resource: the build is refreshed all the same.
    await handler({ data: { query: QUERY } });
    expect(mocks.refreshMcpAuth).toHaveBeenLastCalledWith(mocks.env, null);
  });
});
