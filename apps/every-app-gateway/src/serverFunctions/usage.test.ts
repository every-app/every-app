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
    costUsd?: number | null;
    unlimited?: boolean;
  }>;
const setDefaultMonthlyCapServerFn =
  setDefaultMonthlyCap as unknown as ServerFnBuilder<{
    costUsd: number | null;
  }>;

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
      defaultMonthlyCostCapMicros: 20_000_000,
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

  it("takes dollars from a cent to a million, null to inherit the default, or null and unlimited", () => {
    const validate = setAppMonthlyCapServerFn.validatorFn;
    expect(validate({ appRowId: "app-1", costUsd: 12.5 })).toEqual({
      appRowId: "app-1",
      costUsd: 12.5,
    });
    expect(validate({ appRowId: "app-1", costUsd: 0.01 })).toEqual({
      appRowId: "app-1",
      costUsd: 0.01,
    });
    expect(validate({ appRowId: "app-1", costUsd: 1_000_000 })).toEqual({
      appRowId: "app-1",
      costUsd: 1_000_000,
    });
    expect(validate({ appRowId: "app-1", costUsd: null })).toEqual({
      appRowId: "app-1",
      costUsd: null,
    });
    expect(
      validate({ appRowId: "app-1", costUsd: null, unlimited: true }),
    ).toEqual({ appRowId: "app-1", costUsd: null, unlimited: true });
    expect(
      validate({ appRowId: "app-1", costUsd: 5, unlimited: false }),
    ).toEqual({ appRowId: "app-1", costUsd: 5, unlimited: false });
    for (const costUsd of [0, -1, 0.001, 1_000_000.5, "20", NaN]) {
      expect(() => validate({ appRowId: "app-1", costUsd })).toThrow();
    }
    // A call cap is no field: it is dropped, and the service refuses a
    // call that names nothing.
    expect(validate({ appRowId: "app-1", cap: 5000 })).toEqual({
      appRowId: "app-1",
    });
    expect(() =>
      validate({ appRowId: "app-1", costUsd: 5, unlimited: true }),
    ).toThrow("An app has a cap or no cap, not both");
    expect(() => validate({ appRowId: "", costUsd: 10 })).toThrow(
      "App is required",
    );
    expect(() =>
      validate({ appRowId: "app-1", costUsd: null, unlimited: "yes" }),
    ).toThrow();
  });

  it("sets the cap for the active organization through the service", async () => {
    const state = {
      appRowId: "app-1",
      monthlyCostCapMicros: 20_000_000,
      capUnlimited: false,
      effectiveMonthlyCostCapMicros: 20_000_000,
      costCapSource: "app",
    };
    mocks.setMonthlyCap.mockResolvedValue(state);
    await expect(
      setAppMonthlyCapServerFn.serverHandler({
        data: { appRowId: "app-1", costUsd: 20 },
        context: { org },
      }),
    ).resolves.toEqual(state);
    expect(mocks.setMonthlyCap).toHaveBeenCalledWith(org, {
      appRowId: "app-1",
      costUsd: 20,
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

  it("takes dollars from a cent to a million, or null to clear the default", () => {
    const validate = setDefaultMonthlyCapServerFn.validatorFn;
    expect(validate({ costUsd: 20 })).toEqual({ costUsd: 20 });
    expect(validate({ costUsd: null })).toEqual({ costUsd: null });
    for (const costUsd of [0, 0.001, 2_000_000, "20", undefined]) {
      expect(() => validate({ costUsd })).toThrow();
    }
    expect(() => validate({ cap: 1_000 })).toThrow();
  });

  it("sets the default for the active organization through the service", async () => {
    mocks.setDefaultMonthlyCap.mockResolvedValue({
      defaultMonthlyCostCapMicros: 20_000_000,
    });
    await expect(
      setDefaultMonthlyCapServerFn.serverHandler({
        data: { costUsd: 20 },
        context: { org },
      }),
    ).resolves.toEqual({ defaultMonthlyCostCapMicros: 20_000_000 });
    expect(mocks.setDefaultMonthlyCap).toHaveBeenCalledWith(org, {
      costUsd: 20,
    });
  });
});
