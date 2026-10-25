/**
 * Connected accounts' server functions: a member reads and disconnects
 * their own, an owner or admin everyone's and the organization's; a
 * member asking for another's is refused before the service is reached;
 * the connectable listing carries ids and names only.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationMemberMiddleware: { name: "organizationMemberMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  service: {
    listOAuthProviders: vi.fn(),
    listConnections: vi.fn(),
    disconnect: vi.fn(),
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

import {
  disconnectConnection,
  listAllConnections,
  listConnectableProviders,
  listMyConnections,
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
  listConnectableProviders,
  listAllConnections,
  disconnectConnection,
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
      "listConnectableProviders",
      "disconnectConnection",
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

  it("lists connectable providers as ids and names, those with a live client only", async () => {
    mocks.service.listOAuthProviders.mockResolvedValueOnce([
      {
        id: "github-oauth",
        name: "GitHub",
        client: { source: "d1", clientId: "x" },
        redirectUri: "r",
      },
      { id: "notion-oauth", name: "Notion", client: { source: null } },
    ]);
    const result = await fns["listConnectableProviders"]!.serverHandler({
      context: member,
    });
    expect(result).toEqual({
      providers: [{ id: "github-oauth", name: "GitHub" }],
    });
  });

  describe("disconnectConnection", () => {
    const fn = fns["disconnectConnection"]!;

    it("validates the target", () => {
      expect(
        fn.validatorFn!({ providerId: "github-oauth", account: "user" }),
      ).toEqual({
        providerId: "github-oauth",
        account: "user",
      });
      expect(() =>
        fn.validatorFn!({ providerId: "github-oauth", account: "team" }),
      ).toThrow();
    });

    it("a member disconnects their own account", async () => {
      await fn.serverHandler({
        data: { providerId: "github-oauth", account: "user" },
        context: member,
      });
      expect(mocks.service.disconnect).toHaveBeenLastCalledWith(
        member.org,
        expect.objectContaining({ id: "user_m" }),
        { providerId: "github-oauth", account: "user", userId: "user_m" },
      );
    });

    it("a member is refused another member's and the organization's", async () => {
      mocks.service.disconnect.mockClear();
      await expect(
        fn.serverHandler({
          data: {
            providerId: "github-oauth",
            account: "user",
            userId: "user_a",
          },
          context: member,
        }),
      ).rejects.toThrow(/owner or admin/);
      await expect(
        fn.serverHandler({
          data: { providerId: "github-oauth", account: "organization" },
          context: member,
        }),
      ).rejects.toThrow(/owner or admin/);
      expect(mocks.service.disconnect).not.toHaveBeenCalled();
    });

    it("an admin disconnects anyone's and the organization's", async () => {
      await fn.serverHandler({
        data: { providerId: "github-oauth", account: "user", userId: "user_m" },
        context: admin,
      });
      expect(mocks.service.disconnect).toHaveBeenLastCalledWith(
        admin.org,
        expect.objectContaining({ id: "user_a" }),
        { providerId: "github-oauth", account: "user", userId: "user_m" },
      );
      await fn.serverHandler({
        data: { providerId: "github-oauth", account: "organization" },
        context: admin,
      });
      expect(mocks.service.disconnect).toHaveBeenLastCalledWith(
        admin.org,
        expect.objectContaining({ id: "user_a" }),
        { providerId: "github-oauth", account: "organization" },
      );
    });
  });
});
