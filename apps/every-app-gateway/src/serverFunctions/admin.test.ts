import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  organizationOwnerMiddleware: { name: "organizationOwnerMiddleware" },
  cancelInvitation: vi.fn(),
  getRequest: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.middleware = vi.fn((middlewares: unknown[]) => {
      builder.middlewares = middlewares;
      return builder;
    });
    builder.inputValidator = vi.fn((validator: (data: unknown) => unknown) => {
      builder.validator = validator;
      return builder;
    });
    builder.handler = vi.fn((handler: (input: unknown) => unknown) => {
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
  createAuth: vi.fn(),
}));

vi.mock("@/middleware/auth", () => ({
  organizationAdminMiddleware: mocks.organizationAdminMiddleware,
  organizationOwnerMiddleware: mocks.organizationOwnerMiddleware,
}));

vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));

vi.mock("@/server/services/AdminService", () => ({
  AdminService: {
    hasOwner: vi.fn(),
    initializeOwner: vi.fn(),
    listMembers: vi.fn(),
    deleteUser: vi.fn(),
    cancelInvitation: (...args: unknown[]) => mocks.cancelInvitation(...args),
    sendPasswordResetEmail: vi.fn(),
  },
}));

import { cancelInvitation } from "./admin";

type ServerFnBuilder = {
  middlewares: unknown[];
  validator: (data: unknown) => unknown;
  serverHandler: (input: {
    data: { invitationId: string };
    context: { org: Record<string, unknown> };
  }) => Promise<unknown>;
};

const cancelInvitationServerFn = cancelInvitation as unknown as ServerFnBuilder;

describe("cancelInvitation server function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRequest.mockReturnValue({
      headers: new Headers({ cookie: "session=test" }),
    });
    mocks.cancelInvitation.mockResolvedValue({ success: true });
  });

  it("uses the public error and organization admin gate", () => {
    expect(cancelInvitationServerFn.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("validates the invitation id", () => {
    expect(() =>
      cancelInvitationServerFn.validator({ invitationId: "" }),
    ).toThrow("Invitation ID is required");
  });

  it("passes the active organization and request headers to the service", async () => {
    const org = { orgId: "org-1", userId: "admin-1", role: "admin" };

    await expect(
      cancelInvitationServerFn.serverHandler({
        data: { invitationId: "invite-1" },
        context: { org },
      }),
    ).resolves.toEqual({ success: true });

    expect(mocks.cancelInvitation).toHaveBeenCalledWith(
      org,
      "invite-1",
      mocks.getRequest.mock.results[0]?.value.headers,
    );
  });
});
