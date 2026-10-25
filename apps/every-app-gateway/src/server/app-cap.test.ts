import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capRefusalMessage,
  capThreshold,
  checkMonthlyCap,
  clearAppCapCache,
  effectiveMonthlyCap,
  secondsUntilUtcMonthEnd,
  type AppCapSources,
  type CapSource,
} from "./app-cap";

function sources(cap: number | null, calls = 0, source: CapSource = "app") {
  const effective = vi.fn(async () =>
    cap === null ? { cap: null, source: null } : { cap, source },
  );
  const monthlyCalls = vi.fn(async () => calls);
  const api: AppCapSources = { effectiveMonthlyCap: effective, monthlyCalls };
  return { api, effectiveMonthlyCap: effective, monthlyCalls };
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
  });
});

describe("capRefusalMessage", () => {
  const refused = {
    exceeded: true as const,
    cap: 1000,
    calls: 1000,
    month: "2026-10",
    retryAfterSeconds: 5,
  };

  it("names the cap, where it came from and who raises it, never a person", () => {
    expect(capRefusalMessage("chef", { ...refused, source: "app" })).toBe(
      "chef has reached its monthly cap of 1,000 provider calls for this organization. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
    );
    expect(capRefusalMessage("chef", { ...refused, source: "default" })).toBe(
      "chef has reached its monthly cap of 1,000 provider calls for this organization (the workspace default). Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
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
    const { api, monthlyCalls } = sources(null, 999);
    await expect(checkMonthlyCap(api, "org-a", "app-1")).resolves.toEqual({
      exceeded: false,
    });
    expect(monthlyCalls).not.toHaveBeenCalled();
  });

  it("passes under the cap with the count, and refuses at it with the seconds left in the UTC month", async () => {
    const under = sources(10, 9, "default");
    await expect(checkMonthlyCap(under.api, "org-a", "app-1")).resolves.toEqual(
      {
        exceeded: false,
        cap: 10,
        calls: 9,
        month: "2026-10",
        source: "default",
      },
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
    const { api, effectiveMonthlyCap: read } = sources(10, 0);
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
    expect(none.effectiveMonthlyCap).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-23T12:00:37.000Z"));
    await checkMonthlyCap(none.api, "org-a", "app-1");
    expect(none.effectiveMonthlyCap).toHaveBeenCalledTimes(2);
  });

  it("forgets one organization's cap on an app when it is cleared, and every cap on a full clear", async () => {
    const { api, effectiveMonthlyCap: read } = sources(10, 0);
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
