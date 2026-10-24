import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  summarize: vi.fn(),
  setMonthlyCap: vi.fn(),
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

vi.mock("@/server/services/AppCapService", () => ({
  AppCapService: {
    setMonthlyCap: (...args: unknown[]) => mocks.setMonthlyCap(...args),
  },
  MONTHLY_CALL_CAP_MIN: 1,
  MONTHLY_CALL_CAP_MAX: 1_000_000_000,
}));

import { getUsage, setAppMonthlyCap } from "./usage";

type ServerFnBuilder<TData> = {
  middlewares: unknown[];
  validatorFn: (data: unknown) => unknown;
  serverHandler: (input: {
    data: TData;
    context: { org: Record<string, unknown> };
  }) => Promise<unknown>;
};

const getUsageServerFn = getUsage as unknown as ServerFnBuilder<{
  month: string;
}>;
const setAppMonthlyCapServerFn =
  setAppMonthlyCap as unknown as ServerFnBuilder<{
    appRowId: string;
    cap: number | null;
  }>;

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

describe("setAppMonthlyCap server function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the public error and organization admin gate", () => {
    expect(setAppMonthlyCapServerFn.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("takes a whole cap from 1 to a billion, or null to clear it", () => {
    const validate = setAppMonthlyCapServerFn.validatorFn;
    expect(validate({ appRowId: "app-1", cap: 5000 })).toEqual({
      appRowId: "app-1",
      cap: 5000,
    });
    expect(validate({ appRowId: "app-1", cap: 1 })).toEqual({
      appRowId: "app-1",
      cap: 1,
    });
    expect(validate({ appRowId: "app-1", cap: 1_000_000_000 })).toEqual({
      appRowId: "app-1",
      cap: 1_000_000_000,
    });
    expect(validate({ appRowId: "app-1", cap: null })).toEqual({
      appRowId: "app-1",
      cap: null,
    });
    for (const cap of [0, -1, 1.5, 1_000_000_001, "5000", undefined, NaN]) {
      expect(() => validate({ appRowId: "app-1", cap })).toThrow();
    }
    expect(() => validate({ appRowId: "", cap: 10 })).toThrow(
      "App is required",
    );
  });

  it("sets the cap for the active organization through the service", async () => {
    mocks.setMonthlyCap.mockResolvedValue({
      appRowId: "app-1",
      monthlyCallCap: 5000,
    });
    const org = { orgId: "org-1", userId: "admin-1", role: "admin" };
    await expect(
      setAppMonthlyCapServerFn.serverHandler({
        data: { appRowId: "app-1", cap: 5000 },
        context: { org },
      }),
    ).resolves.toEqual({ appRowId: "app-1", monthlyCallCap: 5000 });
    expect(mocks.setMonthlyCap).toHaveBeenCalledWith(org, {
      appRowId: "app-1",
      cap: 5000,
    });
  });
});
