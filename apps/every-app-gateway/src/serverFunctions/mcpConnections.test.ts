/**
 * The AI connections page's server functions: both need a signed-in user,
 * and both act on that user's own connections only, AI apps and native
 * apps alike. The user comes from the session, never from the request: an
 * id smuggled into the data is dropped before the service is reached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  authMiddleware: { name: "authMiddleware" },
  service: { listForUser: vi.fn(), revokeForUser: vi.fn() },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.middleware = vi.fn((middlewares: unknown[]) => {
      builder.middlewares = middlewares;
      return builder;
    });
    builder.validator = vi.fn((validator: (data: unknown) => unknown) => {
      builder.validatorFn = validator;
      return builder;
    });
    builder.handler = vi.fn((handler: (input: unknown) => unknown) => {
      builder.serverHandler = handler;
      return builder;
    });
    return builder;
  }),
}));
vi.mock("@/middleware/auth", () => ({ authMiddleware: mocks.authMiddleware }));
vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));
vi.mock("@/server/services/McpConnectionService", () => ({
  McpConnectionService: mocks.service,
}));

import { listMyMcpConnections, revokeMyMcpConnection } from "./mcpConnections";

type ServerFnBuilder = {
  middlewares: unknown[];
  validatorFn?: (data: unknown) => unknown;
  serverHandler: (input: {
    data?: unknown;
    context: { user: { id: string } };
  }) => Promise<unknown>;
};

const builder = (fn: unknown) => fn as ServerFnBuilder;

/** Call a server function as its middleware and validator would. */
function call(fn: unknown, data: unknown, userId = "user_ada") {
  const { validatorFn, serverHandler } = builder(fn);
  return serverHandler({
    data: validatorFn ? validatorFn(data) : data,
    context: { user: { id: userId } },
  });
}

beforeEach(() => {
  mocks.service.listForUser.mockReset().mockResolvedValue({ connections: [] });
  mocks.service.revokeForUser.mockReset().mockResolvedValue({ ok: true });
});

describe("AI connections server functions", () => {
  it("need a signed-in user", () => {
    for (const fn of [listMyMcpConnections, revokeMyMcpConnection]) {
      expect(builder(fn).middlewares).toEqual([
        mocks.publicErrorMiddleware,
        mocks.authMiddleware,
      ]);
    }
  });

  it("list the signed-in user's connections", async () => {
    await call(listMyMcpConnections, undefined);
    expect(mocks.service.listForUser).toHaveBeenCalledWith("user_ada");
  });

  it("revoke as the signed-in user, never one named in the request", async () => {
    await call(revokeMyMcpConnection, {
      connectionId: "mcpc_openzen",
      userId: "user_bob",
    });
    expect(mocks.service.revokeForUser).toHaveBeenCalledWith(
      "user_ada",
      "mcpc_openzen",
    );
  });

  it("refuse a revoke without a connection id", () => {
    expect(() => call(revokeMyMcpConnection, {})).toThrow();
    expect(() =>
      call(revokeMyMcpConnection, { connectionId: "x".repeat(65) }),
    ).toThrow();
    expect(mocks.service.revokeForUser).not.toHaveBeenCalled();
  });
});
