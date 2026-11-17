import { describe, expect, it } from "vitest";
import {
  doNotTrack,
  isSwitchedOn,
  USAGE_REPORT_POLICY,
  usageReportNotice,
  usageReportSchedule,
  type UsageReportChoice,
} from "./telemetry.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-16T12:00:00Z");
const choice = (over: Partial<UsageReportChoice> = {}): UsageReportChoice => ({
  existing: false,
  createdAt: T0,
  enabled: null,
  changedAt: null,
  ...over,
});
const policy = (
  existingGateways: typeof USAGE_REPORT_POLICY.existingGateways,
) =>
  ({ ...USAGE_REPORT_POLICY, existingGateways }) as typeof USAGE_REPORT_POLICY;

describe("the usage report policy", () => {
  it("is on after seven days' notice for a Gateway that existed, daily, a day after setup for a new one", () => {
    expect(USAGE_REPORT_POLICY).toMatchObject({
      existingGateways: "on-after-notice",
      noticeDays: 7,
      newGatewayDelayHours: 24,
      intervalHours: 24,
    });
  });

  it("a new Gateway is on, and waits a day", () => {
    expect(usageReportSchedule(choice())).toEqual({
      on: true,
      startsAt: T0 + DAY,
    });
    for (const each of ["ask", "on-after-notice", "on-immediately"] as const) {
      expect(usageReportSchedule(choice(), policy(each))).toEqual({
        on: true,
        startsAt: T0 + DAY,
      });
    }
  });

  it("an existing Gateway follows the one policy value", () => {
    const existing = choice({ existing: true });
    expect(usageReportSchedule(existing)).toEqual({
      on: true,
      startsAt: T0 + 7 * DAY,
    });
    expect(usageReportSchedule(existing, policy("on-immediately"))).toEqual({
      on: true,
      startsAt: T0 + DAY,
    });
    // Asked: off until someone says yes, then at once.
    expect(usageReportSchedule(existing, policy("ask"))).toEqual({
      on: false,
      startsAt: null,
    });
    expect(
      usageReportSchedule(
        choice({ existing: true, enabled: true, changedAt: T0 + 3 * DAY }),
        policy("ask"),
      ),
    ).toEqual({ on: true, startsAt: T0 + 3 * DAY });
  });

  it("off is off under every policy, and on again keeps the first report's day", () => {
    for (const each of ["ask", "on-after-notice", "on-immediately"] as const) {
      expect(
        usageReportSchedule(
          choice({ existing: true, enabled: false, changedAt: T0 }),
          policy(each),
        ),
      ).toEqual({
        on: false,
        startsAt: null,
      });
    }
    expect(
      usageReportSchedule(
        choice({ existing: true, enabled: true, changedAt: T0 + DAY }),
      ),
    ).toEqual({
      on: true,
      startsAt: T0 + 7 * DAY,
    });
  });

  it("the notice names the day, until that day comes", () => {
    const existing = choice({ existing: true });
    expect(usageReportNotice(existing, T0)).toEqual({
      headline: "Usage reports start on 23 November for this Gateway.",
      detail:
        "Once a day it will send Every App a few rounded counts: members, apps, MCP servers, how many people used them, AI tool calls, the version. Never your domain, names, emails or anything inside an app.",
    });
    expect(usageReportNotice(existing, T0 + 7 * DAY)).toBeNull();
    expect(
      usageReportNotice(choice({ existing: true, enabled: false }), T0),
    ).toBeNull();
    expect(usageReportNotice(existing, T0, policy("ask"))).toBeNull();
  });

  it("reads DO_NOT_TRACK as set unless it says 0, false, no or off", () => {
    for (const value of ["1", "true", "yes", "anything"])
      expect(doNotTrack({ DO_NOT_TRACK: value }), value).toBe(true);
    for (const value of ["", "0", "false", "FALSE", "no", " off "])
      expect(doNotTrack({ DO_NOT_TRACK: value }), value).toBe(false);
    expect(doNotTrack({})).toBe(false);
    expect(isSwitchedOn(undefined)).toBe(false);
  });
});
