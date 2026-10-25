import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capRefusalMessage,
  capThreshold,
  checkMonthlyCap,
  clearAppCapCache,
  effectiveMonthlyCap,
  effectiveMonthlyCaps,
  formatUsdMicros,
  microsToUsd,
  secondsUntilUtcMonthEnd,
  type AppCapSources,
  type CapSource,
  type EffectiveCap,
} from "./app-cap";

const NONE: EffectiveCap = { cap: null, source: null };

function sources(
  cap: number | null,
  calls = 0,
  source: CapSource = "app",
  cost: { cap?: number | null; used?: number; source?: CapSource } = {},
) {
  const effective = vi.fn(async () => ({
    calls: cap === null ? NONE : { cap, source },
    cost:
      cost.cap === undefined || cost.cap === null
        ? NONE
        : { cap: cost.cap, source: cost.source ?? "app" },
  }));
  const monthlyUsage = vi.fn(async () => ({
    calls,
    costMicros: cost.used ?? 0,
  }));
  const api: AppCapSources = { effectiveMonthlyCaps: effective, monthlyUsage };
  return { api, effectiveMonthlyCaps: effective, monthlyUsage };
}

describe("secondsUntilUtcMonthEnd", () => {
  it("counts to the first instant of the next UTC month, rounding up", () => {
    expect(secondsUntilUtcMonthEnd(new Date("2026-10-31T23:59:30.000Z"))).toBe(
      30,
    );
    expect(secondsUntilUtcMonthEnd(new Date("2026-10-31T23:59:30.400Z"))).toBe(
      30,
    );
    expect(secondsUntilUtcMonthEnd(new Date("2026-10-01T00:00:00.000Z"))).toBe(
      31 * 24 * 3600,
    );
    // December rolls into the next year.
    expect(secondsUntilUtcMonthEnd(new Date("2026-12-31T23:00:00.000Z"))).toBe(
      3600,
    );
  });

  it("is never below one second", () => {
    expect(
      secondsUntilUtcMonthEnd(new Date("2026-10-31T23:59:59.999Z")),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("effectiveMonthlyCap", () => {
  it("takes the app's own cap first, then unlimited, then the default", () => {
    expect(
      effectiveMonthlyCap({ appCap: 50, unlimited: false, defaultCap: 1000 }),
    ).toEqual({ cap: 50, source: "app" });
    expect(
      effectiveMonthlyCap({ appCap: null, unlimited: true, defaultCap: 1000 }),
    ).toEqual({ cap: null, source: null });
    expect(
      effectiveMonthlyCap({ appCap: null, unlimited: false, defaultCap: 1000 }),
    ).toEqual({ cap: 1000, source: "default" });
    expect(
      effectiveMonthlyCap({ appCap: null, unlimited: false, defaultCap: null }),
    ).toEqual({ cap: null, source: null });
  });

  it("lets a cap win over unlimited on a row that says both, which fails safe", () => {
    expect(
      effectiveMonthlyCap({ appCap: 50, unlimited: true, defaultCap: null }),
    ).toEqual({ cap: 50, source: "app" });
  });
});

describe("effectiveMonthlyCaps", () => {
  it("resolves each kind on its own: an own dollar cap keeps the default call cap", () => {
    expect(
      effectiveMonthlyCaps({
        appCap: null,
        appCostCap: 50_000_000,
        unlimited: false,
        defaultCap: 1000,
        defaultCostCap: 20_000_000,
      }),
    ).toEqual({
      calls: { cap: 1000, source: "default" },
      cost: { cap: 50_000_000, source: "app" },
    });
    expect(
      effectiveMonthlyCaps({
        appCap: 500,
        appCostCap: null,
        unlimited: false,
        defaultCap: null,
        defaultCostCap: 20_000_000,
      }),
    ).toEqual({
      calls: { cap: 500, source: "app" },
      cost: { cap: 20_000_000, source: "default" },
    });
  });

  it("lifts both defaults for an unlimited app", () => {
    expect(
      effectiveMonthlyCaps({
        appCap: null,
        appCostCap: null,
        unlimited: true,
        defaultCap: 1000,
        defaultCostCap: 20_000_000,
      }),
    ).toEqual({ calls: NONE, cost: NONE });
  });
});

describe("capThreshold", () => {
  it("is 100 at the cap, 80 from four fifths of it rounded up, else nothing", () => {
    expect(capThreshold(0, 10)).toBeNull();
    expect(capThreshold(7, 10)).toBeNull();
    expect(capThreshold(8, 10)).toBe(80);
    expect(capThreshold(9, 10)).toBe(80);
    expect(capThreshold(10, 10)).toBe(100);
    expect(capThreshold(12, 10)).toBe(100);
    // ceil(0.8 * 5) = 4; ceil(0.8 * 1) = 1, so a cap of 1 skips 80.
    expect(capThreshold(3, 5)).toBeNull();
    expect(capThreshold(4, 5)).toBe(80);
    expect(capThreshold(0, 1)).toBeNull();
    expect(capThreshold(1, 1)).toBe(100);
    // Micro-dollars the same: $16 of $20 is 80%.
    expect(capThreshold(16_000_000, 20_000_000)).toBe(80);
  });
});

describe("dollars", () => {
  it("rounds micro-dollars to cents and writes them as a person reads them", () => {
    expect(microsToUsd(20_000_000)).toBe(20);
    expect(microsToUsd(12_345_678)).toBe(12.35);
    expect(formatUsdMicros(1_250_000_000)).toBe("$1,250.00");
    expect(formatUsdMicros(10_000)).toBe("$0.01");
  });
});

describe("capRefusalMessage", () => {
  const calls = { kind: "calls" as const, cap: 1000, used: 1000 };
  const cost = { kind: "cost" as const, cap: 20_000_000, used: 20_400_000 };

  it("names the cap, where it came from and who raises it, never a person", () => {
    expect(
      capRefusalMessage("chef", { reached: { ...calls, source: "app" } }),
    ).toBe(
      "chef has reached its monthly cap of 1,000 provider calls for this organization. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
    );
    expect(
      capRefusalMessage("chef", { reached: { ...calls, source: "default" } }),
    ).toBe(
      "chef has reached its monthly cap of 1,000 provider calls for this organization (the workspace default). Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
    );
  });

  it("says dollars for the dollar cap", () => {
    expect(
      capRefusalMessage("chef", { reached: { ...cost, source: "default" } }),
    ).toBe(
      "chef has reached its monthly cap of $20.00 of provider-reported cost for this organization (the workspace default). Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
    );
  });
});

describe("checkMonthlyCap", () => {
  beforeEach(() => {
    clearAppCapCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never reads the counter when no cap is set", async () => {
    const { api, monthlyUsage } = sources(null, 999);
    await expect(checkMonthlyCap(api, "org-a", "app-1")).resolves.toEqual({
      exceeded: false,
    });
    expect(monthlyUsage).not.toHaveBeenCalled();
  });

  it("passes under the cap with the count, and refuses at it with the seconds left in the UTC month", async () => {
    const under = sources(10, 9, "default");
    await expect(checkMonthlyCap(under.api, "org-a", "app-1")).resolves.toEqual(
      {
        exceeded: false,
        month: "2026-10",
        calls: 9,
        costMicros: 0,
        caps: [{ kind: "calls", cap: 10, used: 9, source: "default" }],
      },
    );
    expect(under.monthlyUsage).toHaveBeenCalledWith(
      "org-a",
      "app-1",
      "2026-10",
    );

    clearAppCapCache();
    const at = sources(10, 10);
    const standing = { kind: "calls", cap: 10, used: 10, source: "app" };
    await expect(checkMonthlyCap(at.api, "org-a", "app-1")).resolves.toEqual({
      exceeded: true,
      month: "2026-10",
      calls: 10,
      costMicros: 0,
      caps: [standing],
      reached: standing,
      retryAfterSeconds: secondsUntilUtcMonthEnd(new Date()),
    });
  });

  it("refuses once the reported cost reaches the dollar cap, with no call cap at all", async () => {
    const under = sources(null, 400, "app", {
      cap: 20_000_000,
      used: 19_999_999,
      source: "default",
    });
    await expect(
      checkMonthlyCap(under.api, "org-a", "app-1"),
    ).resolves.toMatchObject({
      exceeded: false,
      costMicros: 19_999_999,
      caps: [
        { kind: "cost", cap: 20_000_000, used: 19_999_999, source: "default" },
      ],
    });

    clearAppCapCache();
    const at = sources(null, 400, "app", { cap: 20_000_000, used: 20_000_000 });
    await expect(
      checkMonthlyCap(at.api, "org-a", "app-1"),
    ).resolves.toMatchObject({
      exceeded: true,
      calls: 400,
      reached: { kind: "cost", cap: 20_000_000, used: 20_000_000 },
    });
  });

  it("is over when either cap is reached, and names the call cap when both are", async () => {
    // Calls well under, dollars over.
    const dollars = sources(1000, 10, "app", {
      cap: 5_000_000,
      used: 6_000_000,
    });
    const byCost = await checkMonthlyCap(dollars.api, "org-a", "app-1");
    expect(byCost.exceeded && byCost.reached.kind).toBe("cost");
    expect(byCost.caps?.map((cap) => cap.kind)).toEqual(["calls", "cost"]);

    clearAppCapCache();
    const both = sources(10, 10, "app", { cap: 5_000_000, used: 6_000_000 });
    const byCalls = await checkMonthlyCap(both.api, "org-a", "app-1");
    expect(byCalls.exceeded && byCalls.reached.kind).toBe("calls");
  });

  it("caches a set cap for 30 seconds and no cap for 5, per organization and app", async () => {
    const { api, effectiveMonthlyCaps: read } = sources(10, 0);
    await checkMonthlyCap(api, "org-a", "app-1");
    await checkMonthlyCap(api, "org-a", "app-1");
    expect(read).toHaveBeenCalledTimes(1);
    await checkMonthlyCap(api, "org-b", "app-1");
    expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-23T12:00:29.000Z"));
    await checkMonthlyCap(api, "org-a", "app-1");
    expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-23T12:00:31.000Z"));
    await checkMonthlyCap(api, "org-a", "app-1");
    expect(read).toHaveBeenCalledTimes(3);

    clearAppCapCache();
    const none = sources(null);
    await checkMonthlyCap(none.api, "org-a", "app-1");
    vi.setSystemTime(new Date("2026-10-23T12:00:35.000Z"));
    await checkMonthlyCap(none.api, "org-a", "app-1");
    expect(none.effectiveMonthlyCaps).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-23T12:00:37.000Z"));
    await checkMonthlyCap(none.api, "org-a", "app-1");
    expect(none.effectiveMonthlyCaps).toHaveBeenCalledTimes(2);
  });

  it("caches a dollar cap alone as a set cap", async () => {
    const { api, effectiveMonthlyCaps: read } = sources(null, 0, "app", {
      cap: 1_000_000,
    });
    await checkMonthlyCap(api, "org-a", "app-1");
    vi.setSystemTime(new Date("2026-10-23T12:00:20.000Z"));
    await checkMonthlyCap(api, "org-a", "app-1");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("forgets one organization's cap on an app when it is cleared, and every cap on a full clear", async () => {
    const { api, effectiveMonthlyCaps: read } = sources(10, 0);
    await checkMonthlyCap(api, "org-a", "app-1");
    await checkMonthlyCap(api, "org-b", "app-1");
    clearAppCapCache("org-a", "app-1");
    await checkMonthlyCap(api, "org-a", "app-1");
    await checkMonthlyCap(api, "org-b", "app-1");
    expect(read).toHaveBeenCalledTimes(3);
    clearAppCapCache();
    await checkMonthlyCap(api, "org-b", "app-1");
    expect(read).toHaveBeenCalledTimes(4);
  });
});
