import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  summarize: vi.fn(),
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
  organizationAdminMiddleware: mocks.organizationAdminMiddleware,
}));

vi.mock("@/middleware/publicError", () => ({
  publicErrorMiddleware: mocks.publicErrorMiddleware,
}));

vi.mock("@/server/repositories/UsageRepository", () => ({
  UsageRepository: {
    summarize: (...args: unknown[]) => mocks.summarize(...args),
  },
}));

import { getUsage } from "./usage";

type ServerFnBuilder = {
  middlewares: unknown[];
  validatorFn: (data: unknown) => unknown;
  serverHandler: (input: {
    data: { month: string };
    context: { org: Record<string, unknown> };
  }) => Promise<unknown>;
};

const getUsageServerFn = getUsage as unknown as ServerFnBuilder;

describe("getUsage server function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the public error and organization admin gate", () => {
    expect(getUsageServerFn.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("takes a YYYY-MM month and nothing else", () => {
    expect(getUsageServerFn.validatorFn({ month: "2026-10" })).toEqual({
      month: "2026-10",
    });
    for (const month of ["2026-13", "2026-1", "2026-10-01", "", "now"]) {
      expect(() => getUsageServerFn.validatorFn({ month })).toThrow(
        "Month must be YYYY-MM",
      );
    }
  });

  it("summarizes the active organization's month, never a requested one", async () => {
    const summary = { month: "2026-10", byApp: [], byMember: [], byTarget: [] };
    mocks.summarize.mockResolvedValue(summary);
    await expect(
      getUsageServerFn.serverHandler({
        data: { month: "2026-10" },
        context: { org: { orgId: "org-1", userId: "admin-1", role: "admin" } },
      }),
    ).resolves.toEqual(summary);
    expect(mocks.summarize).toHaveBeenCalledWith({
      organizationId: "org-1",
      month: "2026-10",
    });
  });
});
