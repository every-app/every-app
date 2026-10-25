import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicErrorMiddleware: { name: "publicErrorMiddleware" },
  organizationAdminMiddleware: { name: "organizationAdminMiddleware" },
  summarize: vi.fn(),
  setMonthlyCap: vi.fn(),
  setDefaultMonthlyCap: vi.fn(),
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
    setDefaultMonthlyCap: (...args: unknown[]) =>
      mocks.setDefaultMonthlyCap(...args),
  },
  MONTHLY_CALL_CAP_MIN: 1,
  MONTHLY_CALL_CAP_MAX: 1_000_000_000,
  MONTHLY_COST_CAP_MIN_USD: 0.01,
  MONTHLY_COST_CAP_MAX_USD: 1_000_000,
}));

import { getUsage, setAppMonthlyCap, setDefaultMonthlyCap } from "./usage";

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
    unlimited?: boolean;
  }>;
const setDefaultMonthlyCapServerFn =
  setDefaultMonthlyCap as unknown as ServerFnBuilder<{ cap: number | null }>;

const org = { orgId: "org-1", userId: "admin-1", role: "admin" };

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
    const summary = {
      month: "2026-10",
      defaultMonthlyCallCap: 1_000,
      byApp: [],
      byMember: [],
      byTarget: [],
    };
    mocks.summarize.mockResolvedValue(summary);
    await expect(
      getUsageServerFn.serverHandler({
        data: { month: "2026-10" },
        context: { org },
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

  it("takes a whole cap from 1 to a billion, null to inherit the default, or null and unlimited", () => {
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
    expect(validate({ appRowId: "app-1", cap: null, unlimited: true })).toEqual(
      { appRowId: "app-1", cap: null, unlimited: true },
    );
    expect(validate({ appRowId: "app-1", cap: 5, unlimited: false })).toEqual({
      appRowId: "app-1",
      cap: 5,
      unlimited: false,
    });
    for (const cap of [0, -1, 1.5, 1_000_000_001, "5000", NaN]) {
      expect(() => validate({ appRowId: "app-1", cap })).toThrow();
    }
    // Dollars beside it, or alone: a cent to a million, or null.
    expect(validate({ appRowId: "app-1", costUsd: 12.5 })).toEqual({
      appRowId: "app-1",
      costUsd: 12.5,
    });
    expect(validate({ appRowId: "app-1", cap: 100, costUsd: null })).toEqual({
      appRowId: "app-1",
      cap: 100,
      costUsd: null,
    });
    for (const costUsd of [0, -1, 0.001, 1_000_000.5, "20", NaN]) {
      expect(() => validate({ appRowId: "app-1", costUsd })).toThrow();
    }
    expect(() =>
      validate({ appRowId: "app-1", costUsd: 5, unlimited: true }),
    ).toThrow("An app has a cap or no cap, not both");
    expect(() => validate({ appRowId: "", cap: 10 })).toThrow(
      "App is required",
    );
    expect(() =>
      validate({ appRowId: "app-1", cap: 10, unlimited: true }),
    ).toThrow("An app has a cap or no cap, not both");
    expect(() =>
      validate({ appRowId: "app-1", cap: null, unlimited: "yes" }),
    ).toThrow();
  });

  it("sets the cap for the active organization through the service", async () => {
    const state = {
      appRowId: "app-1",
      monthlyCallCap: 5000,
      capUnlimited: false,
      effectiveMonthlyCallCap: 5000,
      capSource: "app",
    };
    mocks.setMonthlyCap.mockResolvedValue(state);
    await expect(
      setAppMonthlyCapServerFn.serverHandler({
        data: { appRowId: "app-1", cap: 5000 },
        context: { org },
      }),
    ).resolves.toEqual(state);
    expect(mocks.setMonthlyCap).toHaveBeenCalledWith(org, {
      appRowId: "app-1",
      cap: 5000,
    });
  });
});

describe("setDefaultMonthlyCap server function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the public error and organization admin gate", () => {
    expect(setDefaultMonthlyCapServerFn.middlewares).toEqual([
      mocks.publicErrorMiddleware,
      mocks.organizationAdminMiddleware,
    ]);
  });

  it("takes a whole cap from 1 to a billion, or null to clear the default", () => {
    const validate = setDefaultMonthlyCapServerFn.validatorFn;
    expect(validate({ cap: 1_000 })).toEqual({ cap: 1_000 });
    expect(validate({ cap: null })).toEqual({ cap: null });
    for (const cap of [0, -1, 1.5, 1_000_000_001, "1000", NaN]) {
      expect(() => validate({ cap })).toThrow();
    }
    expect(validate({ costUsd: 20 })).toEqual({ costUsd: 20 });
    expect(validate({ cap: null, costUsd: null })).toEqual({
      cap: null,
      costUsd: null,
    });
    for (const costUsd of [0, 0.001, 2_000_000, "20"]) {
      expect(() => validate({ costUsd })).toThrow();
    }
  });

  it("sets the default for the active organization through the service", async () => {
    mocks.setDefaultMonthlyCap.mockResolvedValue({
      defaultMonthlyCallCap: 1_000,
    });
    await expect(
      setDefaultMonthlyCapServerFn.serverHandler({
        data: { cap: 1_000 },
        context: { org },
      }),
    ).resolves.toEqual({ defaultMonthlyCallCap: 1_000 });
    expect(mocks.setDefaultMonthlyCap).toHaveBeenCalledWith(org, {
      cap: 1_000,
    });
  });
});
