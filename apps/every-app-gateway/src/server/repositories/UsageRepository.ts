import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import {
  apps,
  mcpToolCalls,
  members,
  usageDaily,
  usageMonthly,
  users,
} from "@/db/schema";
import {
  utcDay,
  utcMonth,
  type UsageEvent,
  type UsageRecorder,
} from "@/server/usage-event";
import type { UsageSummary, UsageTotals } from "@/types/usage";

/** Daily rows are kept this many months, monthly rows this many. */
const DAILY_RETENTION_MONTHS = 13;
const MONTHLY_RETENTION_MONTHS = 25;
/** Rows deleted per statement when pruning, so one prune never runs long. */
const PRUNE_BATCH_SIZE = 1000;
/**
 * Statements per table per prune run (the hourly cron's): 10,000 rows an
 * hour each, inside D1's queries-per-invocation budget next to the audit
 * trail's 20. A month of daily rows ages out over the hours after the
 * month boundary; whatever is left goes on the next run.
 */
const PRUNE_MAX_BATCHES = 10;

/**
 * Count one provider call, or add to one: the day's row for (organization,
 * app, user, kind, target) and the month's row for (organization, app),
 * each upserted with the event's deltas, in one batch so the two never
 * disagree. A call (`calls` 1) is written as soon as the provider answers;
 * what its body reported later (`calls` 0: tokens, a cost) is added by a
 * second write, and skipped when there is nothing to add.
 */
async function record(event: UsageEvent): Promise<void> {
  const at = event.at ?? new Date();
  const calls = event.calls;
  const failure = calls === 1 && event.status >= 400 ? 1 : 0;
  const inputTokens = whole(event.inputTokens);
  const outputTokens = whole(event.outputTokens);
  const costMicros = whole(event.costMicros);
  if (calls === 0 && inputTokens + outputTokens + costMicros === 0) return;
  const deltas = {
    calls,
    failures: failure,
    inputTokens,
    outputTokens,
    costMicros,
    updatedAt: at,
  };
  await db.batch([
    db
      .insert(usageDaily)
      .values({
        organizationId: event.organizationId,
        appRowId: event.appRowId,
        userId: event.userId,
        kind: event.kind,
        target: event.target,
        day: utcDay(at),
        ...deltas,
      })
      .onConflictDoUpdate({
        target: [
          usageDaily.organizationId,
          usageDaily.appRowId,
          usageDaily.userId,
          usageDaily.kind,
          usageDaily.target,
          usageDaily.day,
        ],
        set: {
          calls: sql`${usageDaily.calls} + ${calls}`,
          failures: sql`${usageDaily.failures} + ${failure}`,
          inputTokens: sql`${usageDaily.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${usageDaily.outputTokens} + ${outputTokens}`,
          costMicros: sql`${usageDaily.costMicros} + ${costMicros}`,
          updatedAt: at,
        },
      }),
    db
      .insert(usageMonthly)
      .values({
        organizationId: event.organizationId,
        appRowId: event.appRowId,
        month: utcMonth(at),
        ...deltas,
      })
      .onConflictDoUpdate({
        target: [
          usageMonthly.organizationId,
          usageMonthly.appRowId,
          usageMonthly.month,
        ],
        set: {
          calls: sql`${usageMonthly.calls} + ${calls}`,
          failures: sql`${usageMonthly.failures} + ${failure}`,
          inputTokens: sql`${usageMonthly.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${usageMonthly.outputTokens} + ${outputTokens}`,
          costMicros: sql`${usageMonthly.costMicros} + ${costMicros}`,
          updatedAt: at,
        },
      }),
  ]);
}

function whole(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value!)) : 0;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The first day of the month `months` after `month` ("YYYY-MM"). */
function addMonths(month: string, months: number): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  return utcMonth(new Date(Date.UTC(year, index - 1 + months, 1)));
}

const totals = {
  calls: sql<number>`coalesce(sum(${usageDaily.calls}), 0)`.mapWith(Number),
  failures: sql<number>`coalesce(sum(${usageDaily.failures}), 0)`.mapWith(
    Number,
  ),
  inputTokens: sql<number>`coalesce(sum(${usageDaily.inputTokens}), 0)`.mapWith(
    Number,
  ),
  outputTokens:
    sql<number>`coalesce(sum(${usageDaily.outputTokens}), 0)`.mapWith(Number),
  costMicros: sql<number>`coalesce(sum(${usageDaily.costMicros}), 0)`.mapWith(
    Number,
  ),
};

/**
 * The membership a counted call's user holds in the organization it was
 * counted for. Names and emails are read through it, so a person who has
 * since left the organization shows by id, never by the live profile they
 * keep elsewhere.
 */
function memberOf(
  userId: SQLiteColumn,
  organizationId: SQLiteColumn,
): SQL | undefined {
  return and(
    eq(members.userId, userId),
    eq(members.organizationId, organizationId),
  );
}

/**
 * What an organization's apps spent in a UTC month, three ways: per app,
 * per member (with a '' row for the apps' own calls; a former member by
 * id), and per provider or capability. Allowed MCP tool calls come from
 * the audit trail, so an app agents use shows up even before it calls a
 * provider.
 */
async function summarize({
  organizationId,
  month,
}: {
  organizationId: string;
  month: string;
}): Promise<UsageSummary> {
  if (!MONTH.test(month)) throw new Error(`not a month: ${month}`);
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const inMonth = and(
    eq(usageDaily.organizationId, organizationId),
    gte(usageDaily.day, from),
    lt(usageDaily.day, to),
  );
  const fromMs = new Date(`${from}T00:00:00.000Z`);
  const toMs = new Date(`${to}T00:00:00.000Z`);
  const toolCallsInMonth = and(
    eq(mcpToolCalls.organizationId, organizationId),
    eq(mcpToolCalls.decision, "allowed"),
    gte(mcpToolCalls.createdAt, fromMs),
    lt(mcpToolCalls.createdAt, toMs),
  );
  const toolCallCount = sql<number>`count(*)`.mapWith(Number);

  const [byApp, byMember, byTarget, toolCallsByApp, toolCallsByMember] =
    await db.batch([
      db
        .select({
          appRowId: usageDaily.appRowId,
          name: apps.name,
          appSlug: apps.appSlug,
          ...totals,
        })
        .from(usageDaily)
        .leftJoin(apps, eq(apps.id, usageDaily.appRowId))
        .where(inMonth)
        .groupBy(usageDaily.appRowId, apps.name, apps.appSlug),
      db
        .select({
          userId: usageDaily.userId,
          name: users.name,
          email: users.email,
          ...totals,
        })
        .from(usageDaily)
        .leftJoin(
          members,
          memberOf(usageDaily.userId, usageDaily.organizationId),
        )
        .leftJoin(users, eq(users.id, members.userId))
        .where(inMonth)
        .groupBy(usageDaily.userId, users.name, users.email),
      db
        .select({ kind: usageDaily.kind, target: usageDaily.target, ...totals })
        .from(usageDaily)
        .where(inMonth)
        .groupBy(usageDaily.kind, usageDaily.target),
      db
        .select({
          appRowId: mcpToolCalls.appRowId,
          name: apps.name,
          appSlug: apps.appSlug,
          toolCalls: toolCallCount,
        })
        .from(mcpToolCalls)
        .leftJoin(apps, eq(apps.id, mcpToolCalls.appRowId))
        .where(toolCallsInMonth)
        .groupBy(mcpToolCalls.appRowId, apps.name, apps.appSlug),
      db
        .select({
          userId: mcpToolCalls.userId,
          name: users.name,
          email: users.email,
          toolCalls: toolCallCount,
        })
        .from(mcpToolCalls)
        .leftJoin(
          members,
          memberOf(mcpToolCalls.userId, mcpToolCalls.organizationId),
        )
        .leftJoin(users, eq(users.id, members.userId))
        .where(toolCallsInMonth)
        .groupBy(mcpToolCalls.userId, users.name, users.email),
    ]);

  const none: UsageTotals = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
  };
  const appRows = new Map(
    byApp.map((row) => [row.appRowId, { ...row, toolCalls: 0 }]),
  );
  for (const row of toolCallsByApp) {
    // A gateway-surface call on no app has no app to show under.
    if (!row.appRowId) continue;
    const existing = appRows.get(row.appRowId);
    if (existing) existing.toolCalls = row.toolCalls;
    else appRows.set(row.appRowId, { ...none, ...row, appRowId: row.appRowId });
  }
  const memberRows = new Map(
    byMember.map((row) => [row.userId, { ...row, toolCalls: 0 }]),
  );
  for (const row of toolCallsByMember) {
    const existing = memberRows.get(row.userId);
    if (existing) existing.toolCalls = row.toolCalls;
    else memberRows.set(row.userId, { ...none, ...row });
  }
  const byCalls = <T extends { calls: number; toolCalls: number }>(
    a: T,
    b: T,
  ) => b.calls - a.calls || b.toolCalls - a.toolCalls;
  return {
    month,
    byApp: [...appRows.values()].sort(byCalls),
    byMember: [...memberRows.values()].sort(byCalls),
    byTarget: byTarget.sort((a, b) => b.calls - a.calls),
  };
}

/**
 * Delete up to `PRUNE_BATCH_SIZE` rows of `table` matching `condition`, by
 * rowid, up to `maxBatches` times; `done` is false when the run stopped
 * with matching rows left. Bounded like the audit trail's prune, so one
 * run never deletes a whole month of rows in one statement.
 */
async function pruneRows(
  table: SQLiteTable,
  condition: SQL,
  maxBatches: number,
): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await db
      .delete(table)
      .where(
        inArray(
          sql`rowid`,
          db
            .select({ rowid: sql`rowid` })
            .from(table)
            .where(condition)
            .limit(PRUNE_BATCH_SIZE),
        ),
      )
      .returning({ deleted: sql`1` });
    deleted += result.length;
    if (result.length < PRUNE_BATCH_SIZE) return { deleted, done: true };
  }
  return { deleted, done: false };
}

/**
 * Delete daily rows past 13 months and monthly rows past 25, counted from
 * the first of the month `now` is in, in bounded batches; returns how many
 * of each, and whether the run got through them all (the next hourly run
 * carries on when it did not).
 */
async function deleteOlderThan(
  now = new Date(),
  maxBatches = PRUNE_MAX_BATCHES,
): Promise<{ daily: number; monthly: number; done: boolean }> {
  const month = utcMonth(now);
  const dailyCutoff = `${addMonths(month, -DAILY_RETENTION_MONTHS)}-01`;
  const monthlyCutoff = addMonths(month, -MONTHLY_RETENTION_MONTHS);
  const daily = await pruneRows(
    usageDaily,
    lt(usageDaily.day, dailyCutoff),
    maxBatches,
  );
  const monthly = await pruneRows(
    usageMonthly,
    lt(usageMonthly.month, monthlyCutoff),
    maxBatches,
  );
  return {
    daily: daily.deleted,
    monthly: monthly.deleted,
    done: daily.done && monthly.done,
  };
}

export const UsageRepository: UsageRecorder & {
  summarize: typeof summarize;
  deleteOlderThan: typeof deleteOlderThan;
} = {
  record,
  summarize,
  deleteOlderThan,
} as const;
