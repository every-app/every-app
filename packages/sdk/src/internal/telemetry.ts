/**
 * Usage reports (telemetry): the rules the Gateway, the CLI and the admin
 * page share, so the policy is one value and the words are written once.
 *
 * A self-hosted Gateway from a published release sends one short report a
 * day to USAGE_REPORT_ENDPOINT (apps/every-app-gateway/src/server/telemetry,
 * received by apps/telemetry). Nothing else sends anything: not the CLI,
 * not the Mac app, not apps, not this SDK.
 */

/** Where reports go: our own Worker (apps/telemetry). */
export const USAGE_REPORT_ENDPOINT = "https://telemetry.everyapp.com/v1/report";

/**
 * What a Gateway that existed before usage reports does once it updates:
 *
 *  - `on-after-notice`: reports are on, and the first one waits
 *    `noticeDays` so the notice comes first;
 *  - `ask`: reports stay off until an owner or admin turns them on;
 *  - `on-immediately`: as a new Gateway, the first report a day later.
 */
export type ExistingGatewayPolicy =
  | "ask"
  | "on-after-notice"
  | "on-immediately";

/** The whole policy. Change a value here and every surface follows. */
export const USAGE_REPORT_POLICY = {
  existingGateways: "on-after-notice" as ExistingGatewayPolicy,
  /** Days between an existing Gateway's update and its first report. */
  noticeDays: 7,
  /** Hours between a new Gateway's setup and its first report. */
  newGatewayDelayHours: 24,
  /**
   * Hours between reports. A report covers one UTC day and the receiver
   * keeps one per Gateway per day, so anything but 24 changes both.
   */
  intervalHours: 24,
  /** Tries a day; a report that fails three times waits for tomorrow. */
  attemptsPerDay: 3,
} as const;

/**
 * The Gateway setting that turns reports off for good (`everyapp secret
 * set TELEMETRY_DISABLED`): the switch can't turn them on while it is set.
 */
export const USAGE_REPORTS_DISABLED_SETTING = "TELEMETRY_DISABLED";

/** A switch variable's value: set to anything but 0, false, no or off. */
export function isSwitchedOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && !["0", "false", "no", "off"].includes(normalized);
}

/**
 * Whether the person's shell asks not to be tracked: DO_NOT_TRACK set to
 * anything but 0, false, no or off. `everyapp setup` and `everyapp update`
 * then leave the Gateway's usage reports off.
 */
export function doNotTrack(env: Record<string, string | undefined>): boolean {
  return isSwitchedOn(env["DO_NOT_TRACK"]);
}

/** What the Gateway keeps about the choice (its `telemetry_state` row). */
export interface UsageReportChoice {
  /** The Gateway had an owner before usage reports existed. */
  existing: boolean;
  /** When this Gateway first had usage reports (ms). */
  createdAt: number;
  /** What someone chose; null while nobody has. */
  enabled: boolean | null;
  /** When they chose (ms). */
  changedAt: number | null;
}

export interface UsageReportSchedule {
  on: boolean;
  /** No report before this (ms); null while reports are off. */
  startsAt: number | null;
}

const HOUR_MS = 60 * 60 * 1000;

/** Whether reports are on, and the earliest time of the first one. */
export function usageReportSchedule(
  choice: UsageReportChoice,
  policy: typeof USAGE_REPORT_POLICY = USAGE_REPORT_POLICY,
): UsageReportSchedule {
  const asked = choice.existing && policy.existingGateways === "ask";
  const on = choice.enabled ?? !asked;
  if (!on) return { on, startsAt: null };
  const wait =
    choice.existing && policy.existingGateways === "on-after-notice"
      ? policy.noticeDays * 24 * HOUR_MS
      : policy.newGatewayDelayHours * HOUR_MS;
  // Asked and answered yes: there is nothing left to wait for.
  const startsAt = asked
    ? (choice.changedAt ?? choice.createdAt)
    : choice.createdAt + wait;
  return { on, startsAt };
}

/** "23 November": the day a first report may go, in UTC. */
export function usageReportDate(time: number): string {
  return new Date(time).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** What a report holds, in one sentence, wherever a notice says it. */
export const USAGE_REPORT_CONTENTS =
  "a few rounded counts: members, apps, MCP servers, how many people used them, AI tool calls, the version. Never your domain, names, emails or anything inside an app.";

export const USAGE_REPORT_DOCS_URL = "https://everyapp.com/docs/telemetry";

/**
 * The notice an owner or admin reads before a first report, in the CLI
 * and on the admin page: a headline and one more line. Null when reports
 * are off or the first one has gone.
 */
export function usageReportNotice(
  choice: UsageReportChoice,
  now: number,
  policy: typeof USAGE_REPORT_POLICY = USAGE_REPORT_POLICY,
): { headline: string; detail: string } | null {
  const { on, startsAt } = usageReportSchedule(choice, policy);
  if (!on || startsAt === null || startsAt <= now) return null;
  return {
    headline: `Usage reports start on ${usageReportDate(startsAt)} for this Gateway.`,
    detail: `Once a day it will send Every App ${USAGE_REPORT_CONTENTS}`,
  };
}
