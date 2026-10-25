import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkMonthlyCap,
  clearAppCapCache,
  secondsUntilUtcMonthEnd,
  type AppCapSources,
} from "./app-cap";

function sources(cap: number | null, calls = 0) {
  const monthlyCallCap = vi.fn(async () => cap);
  const monthlyCalls = vi.fn(async () => calls);
  const api: AppCapSources = { monthlyCallCap, monthlyCalls };
  return { api, monthlyCallCap, monthlyCalls };
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
    const { api, monthlyCalls } = sources(null, 999);
    await expect(checkMonthlyCap(api, "org-a", "app-1")).resolves.toEqual({
      exceeded: false,
    });
    expect(monthlyCalls).not.toHaveBeenCalled();
  });

  it("passes under the cap with the month's standing, and refuses at it with the seconds left in the UTC month", async () => {
    const under = sources(10, 9);
    await expect(checkMonthlyCap(under.api, "org-a", "app-1")).resolves.toEqual(
      { exceeded: false, cap: 10, calls: 9, month: "2026-10", source: "app" },
    );
    expect(under.monthlyCalls).toHaveBeenCalledWith(
      "org-a",
      "app-1",
      "2026-10",
    );

    clearAppCapCache();
    const at = sources(10, 10);
    await expect(checkMonthlyCap(at.api, "org-a", "app-1")).resolves.toEqual({
      exceeded: true,
      cap: 10,
      calls: 10,
      month: "2026-10",
      source: "app",
      retryAfterSeconds: secondsUntilUtcMonthEnd(new Date()),
    });
  });

  it("caches a set cap for 30 seconds and no cap for 5, per organization and app", async () => {
    const { api, monthlyCallCap } = sources(10, 0);
    await checkMonthlyCap(api, "org-a", "app-1");
    await checkMonthlyCap(api, "org-a", "app-1");
    expect(monthlyCallCap).toHaveBeenCalledTimes(1);
    await checkMonthlyCap(api, "org-b", "app-1");
    expect(monthlyCallCap).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-23T12:00:29.000Z"));
    await checkMonthlyCap(api, "org-a", "app-1");
    expect(monthlyCallCap).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-23T12:00:31.000Z"));
    await checkMonthlyCap(api, "org-a", "app-1");
    expect(monthlyCallCap).toHaveBeenCalledTimes(3);

    clearAppCapCache();
    const none = sources(null);
    await checkMonthlyCap(none.api, "org-a", "app-1");
    vi.setSystemTime(new Date("2026-10-23T12:00:35.000Z"));
    await checkMonthlyCap(none.api, "org-a", "app-1");
    expect(none.monthlyCallCap).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-23T12:00:37.000Z"));
    await checkMonthlyCap(none.api, "org-a", "app-1");
    expect(none.monthlyCallCap).toHaveBeenCalledTimes(2);
  });

  it("forgets one organization's cap on an app when it is cleared, and every cap on a full clear", async () => {
    const { api, monthlyCallCap } = sources(10, 0);
    await checkMonthlyCap(api, "org-a", "app-1");
    await checkMonthlyCap(api, "org-b", "app-1");
    clearAppCapCache("org-a", "app-1");
    await checkMonthlyCap(api, "org-a", "app-1");
    await checkMonthlyCap(api, "org-b", "app-1");
    expect(monthlyCallCap).toHaveBeenCalledTimes(3);
    clearAppCapCache();
    await checkMonthlyCap(api, "org-b", "app-1");
    expect(monthlyCallCap).toHaveBeenCalledTimes(4);
  });
});
