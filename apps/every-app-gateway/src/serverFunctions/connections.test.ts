/**
 * Connected accounts' server functions: a member reads their own, an
 * owner or admin everyone's; a disconnect names the connection by id, an
 * app's removal the connection and the app's row, and the service decides
 * whose it may change.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationMemberMiddleware: { name: "organizationMemberMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  service: {
    listConnections: vi.fn(),
    disconnect: vi.fn(),
    removeAppAccess: vi.fn(),
  },
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
vi.mock("@/middleware/auth", () => ({
  organizationMemberMiddleware: mocks.organizationMemberMiddleware,
  organizationAdminMiddleware: mocks.organizationAdminMiddleware,
}));
vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));
vi.mock("@/server/oauth/service", () => mocks.service);
vi.mock("@/server/oauth/flow", () => ({ startReconnect: vi.fn() }));

import {
  disconnectConnection,
  listAllConnections,
  listMyConnections,
  removeConnectionApp,
} from "./connections";

type ServerFnBuilder = {
  middlewares: unknown[];
  validatorFn?: (data: unknown) => unknown;
  serverHandler: (input: {
    data?: unknown;
    context: {
      org: { orgId: string; userId: string; role: string };
      user: { id: string; email?: string | null };
    };
  }) => Promise<unknown>;
};

const fns = {
  listMyConnections,
  listAllConnections,
  disconnectConnection,
  removeConnectionApp,
} as unknown as Record<string, ServerFnBuilder>;

const member = {
  org: { orgId: "org_1", userId: "user_m", role: "member" },
  user: { id: "user_m", email: "m@example.com" },
};
const admin = {
  org: { orgId: "org_1", userId: "user_a", role: "admin" },
  user: { id: "user_a", email: "a@example.com" },
};

describe("connection server functions", () => {
  it("gates the member functions on membership and the organization listing on admin", () => {
    for (const name of [
      "listMyConnections",
      "disconnectConnection",
      "removeConnectionApp",
    ]) {
      expect(fns[name]!.middlewares).toEqual([
        mocks.publicErrorMiddleware,
        mocks.organizationMemberMiddleware,
      ]);
    }
    expect(fns["listAllConnections"]!.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("lists my own connections by my user id, and everyone's for an admin", async () => {
    mocks.service.listConnections.mockResolvedValue([]);
    await fns["listMyConnections"]!.serverHandler({ context: member });
    expect(mocks.service.listConnections).toHaveBeenLastCalledWith(member.org, {
      user: "user_m",
    });
    await fns["listAllConnections"]!.serverHandler({ context: admin });
    expect(mocks.service.listConnections).toHaveBeenLastCalledWith(admin.org, {
      user: "all",
    });
  });

  describe("disconnectConnection", () => {
    const fn = fns["disconnectConnection"]!;

    it("validates the target: a connection id", () => {
      expect(fn.validatorFn!({ connectionId: "conn_1" })).toEqual({
        connectionId: "conn_1",
      });
      expect(() => fn.validatorFn!({ connectionId: "" })).toThrow();
      expect(() =>
        fn.validatorFn!({ providerId: "github-oauth", account: "user" }),
      ).toThrow();
    });

    it("passes the connection id and the caller to the service", async () => {
      mocks.service.disconnect.mockResolvedValueOnce({
        removed: true,
        revoked: false,
      });
      const result = await fn.serverHandler({
        data: { connectionId: "conn_1" },
        context: member,
      });
      expect(result).toEqual({ ok: true, revoked: false });
      expect(mocks.service.disconnect).toHaveBeenLastCalledWith(
        member.org,
        expect.objectContaining({ id: "user_m" }),
        { connectionId: "conn_1" },
      );
    });

    it("lets the service's refusal through", async () => {
      mocks.service.disconnect.mockRejectedValueOnce(
        new Error("Only an owner or admin can manage OAuth providers"),
      );
      await expect(
        fn.serverHandler({ data: { connectionId: "conn_2" }, context: member }),
      ).rejects.toThrow(/owner or admin/);
    });
  });

  describe("removeConnectionApp", () => {
    const fn = fns["removeConnectionApp"]!;

    it("validates the target: a connection id and the app's row id", () => {
      expect(
        fn.validatorFn!({ connectionId: "conn_1", appRowId: "app-row-1" }),
      ).toEqual({ connectionId: "conn_1", appRowId: "app-row-1" });
      expect(() => fn.validatorFn!({ connectionId: "conn_1" })).toThrow();
      expect(() =>
        fn.validatorFn!({ connectionId: "", appRowId: "app-row-1" }),
      ).toThrow();
      expect(() =>
        fn.validatorFn!({ connectionId: "conn_1", appRowId: "" }),
      ).toThrow();
    });

    it("takes that one app's access away through the service, as the caller, and disconnects nothing", async () => {
      mocks.service.removeAppAccess.mockResolvedValueOnce({ removed: true });
      mocks.service.disconnect.mockClear();
      const result = await fn.serverHandler({
        data: { connectionId: "conn_1", appRowId: "app-row-1" },
        context: member,
      });
      expect(result).toEqual({ ok: true });
      expect(mocks.service.removeAppAccess).toHaveBeenLastCalledWith(
        member.org,
        { connectionId: "conn_1", app: "app-row-1" },
      );
      expect(mocks.service.disconnect).not.toHaveBeenCalled();
    });

    it("lets the service's refusal through", async () => {
      mocks.service.removeAppAccess.mockRejectedValueOnce(
        new Error("Only an owner or admin can manage OAuth providers"),
      );
      await expect(
        fn.serverHandler({
          data: { connectionId: "conn_2", appRowId: "app-row-1" },
          context: member,
        }),
      ).rejects.toThrow(/owner or admin/);
    });
  });
});
