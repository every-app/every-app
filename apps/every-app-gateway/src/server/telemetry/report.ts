/**
 * Usage reports: whether this Gateway sends them, the switch, and the
 * hourly step that sends one a day (https://everyapp.com/docs/telemetry).
 *
 * A report goes only when all of these hold, checked in `whyNot`:
 *
 *  - the Gateway is self-hosted (`platformPolicy().usageReports`);
 *  - the TELEMETRY_DISABLED setting is not set;
 *  - nobody turned reports off (the `telemetry_state` row), and on a
 *    Gateway that predates them the policy says they are on;
 *  - the Worker runs a published release: the CLI stamps
 *    `EVERYAPP_RELEASE.published` only on a release it downloaded from
 *    Every App's own repository, so a checkout build, a fork, a dev server
 *    and a test never send;
 *  - the first report's time has come (a day after setup, or the notice
 *    period after the update that brought reports to an existing Gateway).
 *
 * The step never breaks the Gateway: one try an hour, three a day, five
 * seconds each, and a failure is one log line. The only request to our
 * host in the Gateway is the `fetch` below.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  isSwitchedOn,
  USAGE_REPORT_ENDPOINT,
  USAGE_REPORT_POLICY,
  USAGE_REPORTS_DISABLED_SETTING,
  usageReportNotice,
  usageReportSchedule,
  type UsageReportChoice,
} from "@every-app/sdk/internal";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { telemetryState } from "@/db/schema";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";
import { buildUsageReport, reportDay, type UsageReport } from "./payload";

const ROW = "telemetry";
const SEND_TIMEOUT_MS = 5_000;

interface TelemetryEnv {
  GATEWAY_DEPLOYMENT_MODE?: string;
  TELEMETRY_DISABLED?: string;
  EVERYAPP_RELEASE?: { version?: string; published?: boolean };
}

/** Why no report goes, in the order the reasons are checked. */
type OffReason =
  /** Not a self-hosted Gateway: there is nothing to turn on. */
  | "unavailable"
  /** The TELEMETRY_DISABLED setting. */
  | "setting"
  /** Someone turned reports off, or nobody has turned them on yet. */
  | "off"
  /** Built from source, not a published release. */
  | "unpublished";

type StateRow = typeof telemetryState.$inferSelect;

async function readState(): Promise<StateRow | null> {
  const [row] = await db
    .select()
    .from(telemetryState)
    .where(eq(telemetryState.id, ROW))
    .limit(1);
  return row ?? null;
}

function choiceOf(row: StateRow): UsageReportChoice {
  return {
    existing: row.existing,
    createdAt: row.createdAt.getTime(),
    enabled: row.enabled,
    changedAt: row.changedAt?.getTime() ?? null,
  };
}

function whyNot(
  settings: TelemetryEnv,
  row: StateRow | null,
): OffReason | null {
  if (!platformPolicy(settings).usageReports) return "unavailable";
  if (isSwitchedOn(settings.TELEMETRY_DISABLED)) return "setting";
  if (!row || !usageReportSchedule(choiceOf(row)).on) return "off";
  if (settings.EVERYAPP_RELEASE?.published !== true) return "unpublished";
  return null;
}

/** A new random id for reports to carry: 32 hex characters, derived from nothing. */
const newInstallId = () => crypto.randomUUID().replaceAll("-", "");

/** What Manage workspace → Usage reports, `everyapp telemetry` and the tools show. */
interface UsageReportStatus {
  /** `on` when this Gateway sends reports; `off` otherwise, with `reason`. */
  usageReports: "on" | "off";
  /**
   * Why they are off: `unavailable` (not a self-hosted Gateway), `setting`
   * (TELEMETRY_DISABLED is set), `off` (turned off, or never
   * turned on), `unpublished` (built from source, which never sends).
   */
  reason: OffReason | null;
  /** Whether the switch can turn them on or off here. */
  canChange: boolean;
  /** When the first report may go (ISO), while it hasn't. */
  startsAt: string | null;
  /** The notice to show before a first report. */
  notice: { headline: string; detail: string } | null;
  /** The report that would go next, exactly as it would be sent. */
  nextReport: UsageReport | null;
  /** The last one sent, and the day it was for. */
  lastReport: UsageReport | null;
  lastReportedDay: string | null;
  /** Where reports go. */
  endpoint: string;
}

function parseReport(text: string | null): UsageReport | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as UsageReport;
  } catch {
    return null;
  }
}

/** The switch's state and the report as it would go now. */
export async function usageReportStatus(
  now = new Date(),
  settings: TelemetryEnv = env as unknown as TelemetryEnv,
): Promise<UsageReportStatus> {
  const row = await readState();
  const reason = whyNot(settings, row);
  const schedule = row ? usageReportSchedule(choiceOf(row)) : null;
  // A report is shown while reports are on by choice, also on a build
  // that never sends: it is how the numbers are checked before a release.
  const shown =
    row?.installId && (reason === null || reason === "unpublished")
      ? row.installId
      : null;
  const waiting =
    reason === null && schedule?.startsAt != null
      ? schedule.startsAt > now.getTime()
      : false;
  return {
    usageReports: reason === null ? "on" : "off",
    reason,
    canChange: reason !== "unavailable" && reason !== "setting",
    startsAt:
      waiting && schedule?.startsAt != null
        ? new Date(schedule.startsAt).toISOString()
        : null,
    notice:
      row && reason === null
        ? usageReportNotice(choiceOf(row), now.getTime())
        : null,
    nextReport: shown
      ? await buildUsageReport({
          install: shown,
          version: settings.EVERYAPP_RELEASE?.version ?? "dev",
          now,
        })
      : null,
    lastReport: parseReport(row?.lastPayload ?? null),
    lastReportedDay: row?.reportedDay ?? null,
    endpoint: USAGE_REPORT_ENDPOINT,
  };
}

/**
 * Turn usage reports on or off (owners and admins). Off stops them at
 * once and deletes the random id (the migration made the first one) and
 * the copy of the last report; on again starts with a new id.
 */
export async function setUsageReports(
  ctx: OrgContext,
  on: boolean,
  now = new Date(),
  settings: TelemetryEnv = env as unknown as TelemetryEnv,
): Promise<UsageReportStatus & { changed: boolean }> {
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    throw new PublicError(
      "ADMIN_REQUIRED",
      "Only owners and admins change usage reports",
    );
  }
  if (!platformPolicy(settings).usageReports) {
    throw new PublicError(
      "INVALID_INPUT",
      "This Gateway doesn't send usage reports: there is nothing to turn on or off",
    );
  }
  if (on && isSwitchedOn(settings.TELEMETRY_DISABLED)) {
    throw new PublicError(
      "INVALID_INPUT",
      `Usage reports are turned off by the ${USAGE_REPORTS_DISABLED_SETTING} setting. Remove it first: everyapp secret unset ${USAGE_REPORTS_DISABLED_SETTING}`,
    );
  }
  const before = await readState();
  const wasOn = before ? usageReportSchedule(choiceOf(before)).on : false;
  await db
    .update(telemetryState)
    .set({
      enabled: on,
      changedAt: now,
      changedBy: ctx.userId,
      // Off deletes the id; on again starts with a new one.
      ...(on
        ? before?.installId
          ? {}
          : { installId: newInstallId() }
        : { installId: null, lastPayload: null }),
    })
    .where(eq(telemetryState.id, ROW));
  logEvent("telemetry.changed", { on, user_id: ctx.userId });
  return { ...(await usageReportStatus(now, settings)), changed: wasOn !== on };
}

/**
 * Take today's try: true once per try, at most `attemptsPerDay` a day and
 * never for a day already reported. Two cron runs at once can both take
 * one; the receiver keeps the first report for a day.
 */
async function claim(day: string): Promise<boolean> {
  const claimed = await db
    .update(telemetryState)
    .set({
      attemptDay: day,
      attempts: sql`case when ${telemetryState.attemptDay} = ${day} then ${telemetryState.attempts} + 1 else 1 end`,
    })
    .where(
      and(
        eq(telemetryState.id, ROW),
        or(
          isNull(telemetryState.reportedDay),
          lt(telemetryState.reportedDay, day),
        ),
        or(
          isNull(telemetryState.attemptDay),
          ne(telemetryState.attemptDay, day),
          lt(telemetryState.attempts, USAGE_REPORT_POLICY.attemptsPerDay),
        ),
      ),
    )
    .returning({ attempts: telemetryState.attempts });
  return claimed.length > 0;
}

type ReportOutcome =
  | OffReason
  /** The first report's time hasn't come. */
  | "waiting"
  /** Yesterday is reported, or today's tries are used up. */
  | "done"
  /** Nobody has claimed the Gateway yet. */
  | "not_set_up"
  | "sent"
  | "failed";

/**
 * The hourly step (server/mcp-auth/maintenance.ts): send yesterday's
 * report if one is due. It never throws.
 */
export async function runUsageReport(
  settings: TelemetryEnv,
  now = new Date(),
  send: typeof fetch = (input, init) => fetch(input, init),
): Promise<ReportOutcome> {
  try {
    const row = await readState();
    const reason = whyNot(settings, row);
    if (reason || !row) return reason ?? "off";
    const { startsAt } = usageReportSchedule(choiceOf(row));
    if (startsAt === null || startsAt > now.getTime()) return "waiting";
    const day = reportDay(now);
    if (row.reportedDay !== null && row.reportedDay >= day) return "done";
    if (!row.installId || !(await claim(day))) return "done";
    const report = await buildUsageReport({
      install: row.installId,
      version: settings.EVERYAPP_RELEASE?.version ?? "",
      now,
    });
    if (!report) return "not_set_up";
    const body = JSON.stringify(report);
    const response = await send(USAGE_REPORT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`the receiver answered ${response.status}`);
    // Not if reports were turned off while this one was on its way.
    await db
      .update(telemetryState)
      .set({ reportedDay: day, lastPayload: body, lastReportedAt: now })
      .where(
        and(
          eq(telemetryState.id, ROW),
          or(isNull(telemetryState.enabled), eq(telemetryState.enabled, true)),
        ),
      );
    return "sent";
  } catch (error) {
    logEvent(
      "telemetry.report_failed",
      { message: error instanceof Error ? error.message : String(error) },
      "warn",
    );
    return "failed";
  }
}
