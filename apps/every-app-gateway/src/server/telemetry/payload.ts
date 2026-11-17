/**
 * The usage report: everything a Gateway sends us, built here and nowhere
 * else (https://everyapp.com/docs/telemetry; apps/telemetry receives it).
 *
 * Counts only, each rounded down to one significant digit, from tables the
 * Gateway already keeps. It reads ids, roles, timestamps and app slugs. It
 * never reads a name, an email, a hostname, a manifest, a tool's name, a
 * secret, or `_everyapp_install` (the account, the zone and the Gateway's
 * host): payload.test.ts fails if this file names one of those columns,
 * and if the report's keys differ from apps/telemetry/example-report.json.
 */
import { and, asc, eq, exists, gte, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  apps,
  mcpToolCalls,
  members,
  organizations,
  sessions,
  usageDaily,
} from "@/db/schema";

/**
 * The apps of ours a report names, by manifest id. Every other app is the
 * word "other": we see that an app of the operator's own is used, never
 * what it is. apps/telemetry's `APPS` is the same list plus "other".
 */
export const NAMED_APPS: readonly string[] = [
  "openseo",
  "crm",
  "openmail",
  "analytics",
  "scribe",
];

/** `members` and the active counts stop here: a very large team would stand out. */
const MEMBER_CAP = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AppUse {
  app: string;
  active_members: number;
  tool_calls: number;
}

/** The report. Adding a key here fails payload.test.ts until the receiver and the docs name it. */
export interface UsageReport {
  schema: 1;
  /** Random, made by this Gateway for this and nothing else. */
  install: string;
  /** The UTC day the counts are for: yesterday. */
  day: string;
  version: string;
  /** The month the Gateway was set up. */
  installed: string;
  members: number;
  active_members_1d: number;
  active_members_7d: number;
  apps: number;
  app_use_1d: AppUse[];
}

/** Rounded down to one significant digit: 7 stays 7, 37 is 30, 4812 is 4000. */
export function roundDown(
  count: number,
  cap = Number.MAX_SAFE_INTEGER,
): number {
  const whole = Math.min(Math.max(0, Math.floor(count)), cap);
  if (whole < 10) return whole;
  const magnitude = 10 ** Math.floor(Math.log10(whole));
  return Math.floor(whole / magnitude) * magnitude;
}

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The UTC day before `now`: the day a report sent now is for. */
export function reportDay(now: Date): string {
  return utcDay(now.getTime() - DAY_MS);
}

/**
 * The people active from `fromDay` to `toDay`: anyone whose session was
 * refreshed since the first day began, who called a tool, or who caused a
 * provider call. A session is refreshed at most once a day, so the one-day
 * count is a floor.
 */
async function activePeople(
  fromDay: string,
  toDay: string,
): Promise<Set<string>> {
  const from = new Date(`${fromDay}T00:00:00Z`);
  const until = new Date(Date.parse(`${toDay}T00:00:00Z`) + DAY_MS);
  const [signedIn, calledTools, usedProviders] = await Promise.all([
    db
      .selectDistinct({ user: sessions.userId })
      .from(sessions)
      .where(gte(sessions.updatedAt, from)),
    db
      .selectDistinct({ user: mcpToolCalls.userId })
      .from(mcpToolCalls)
      .where(
        and(
          gte(mcpToolCalls.createdAt, from),
          lt(mcpToolCalls.createdAt, until),
        ),
      ),
    db
      .selectDistinct({ user: usageDaily.userId })
      .from(usageDaily)
      .where(
        and(
          gte(usageDaily.day, fromDay),
          lte(usageDaily.day, toDay),
          ne(usageDaily.userId, ""),
        ),
      ),
  ]);
  return new Set(
    [...signedIn, ...calledTools, ...usedProviders].map((row) => row.user),
  );
}

/** Use per app on `day`: the members behind its tool calls and provider calls, and its tool calls. */
async function appUse(day: string): Promise<AppUse[]> {
  const from = new Date(`${day}T00:00:00Z`);
  const until = new Date(from.getTime() + DAY_MS);
  const [slugs, toolCalls, providerCalls] = await Promise.all([
    db.select({ id: apps.id, slug: apps.appSlug }).from(apps),
    db
      .select({
        appRowId: mcpToolCalls.appRowId,
        user: mcpToolCalls.userId,
        calls: sql<number>`count(*)`,
      })
      .from(mcpToolCalls)
      .where(
        and(
          gte(mcpToolCalls.createdAt, from),
          lt(mcpToolCalls.createdAt, until),
          eq(mcpToolCalls.surface, "app"),
          eq(mcpToolCalls.decision, "allowed"),
        ),
      )
      .groupBy(mcpToolCalls.appRowId, mcpToolCalls.userId),
    db
      .selectDistinct({
        appRowId: usageDaily.appRowId,
        user: usageDaily.userId,
      })
      .from(usageDaily)
      .where(eq(usageDaily.day, day)),
  ]);
  const slugOf = new Map(slugs.map((row) => [row.id, row.slug]));
  const named = (appRowId: string | null) => {
    const slug = appRowId ? slugOf.get(appRowId) : undefined;
    return slug && NAMED_APPS.includes(slug) ? slug : "other";
  };
  const use = new Map<string, { people: Set<string>; calls: number }>();
  const entry = (app: string) => {
    const found = use.get(app) ?? { people: new Set<string>(), calls: 0 };
    use.set(app, found);
    return found;
  };
  for (const row of toolCalls) {
    const app = entry(named(row.appRowId));
    app.people.add(row.user);
    app.calls += Number(row.calls);
  }
  for (const row of providerCalls) {
    const app = entry(named(row.appRowId));
    // '' is the app's own background work: use, with nobody behind it.
    if (row.user) app.people.add(row.user);
  }
  return [...NAMED_APPS, "other"]
    .filter((app) => use.has(app))
    .map((app) => ({
      app,
      active_members: roundDown(use.get(app)!.people.size, MEMBER_CAP),
      tool_calls: roundDown(use.get(app)!.calls),
    }));
}

/** When the Gateway was set up: the month its first organization with an owner was made. */
async function installedMonth(): Promise<string | null> {
  const [first] = await db
    .select({ createdAt: organizations.createdAt })
    .from(organizations)
    .where(
      exists(
        db
          .select({ id: members.id })
          .from(members)
          .where(
            and(
              eq(members.organizationId, organizations.id),
              eq(members.role, "owner"),
            ),
          ),
      ),
    )
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);
  return first ? first.createdAt.toISOString().slice(0, 7) : null;
}

/**
 * The report for the day before `now`, or null on a Gateway nobody has
 * claimed yet. `install` and `version` are the caller's: the state row's
 * random id and the release's version.
 */
export async function buildUsageReport(input: {
  install: string;
  version: string;
  now: Date;
}): Promise<UsageReport | null> {
  const day = reportDay(input.now);
  const weekStart = utcDay(Date.parse(`${day}T00:00:00Z`) - 6 * DAY_MS);
  const [installed, memberCount, appCount, activeDay, activeWeek, use] =
    await Promise.all([
      installedMonth(),
      db
        .select({ count: sql<number>`count(distinct ${members.userId})` })
        .from(members),
      db
        .select({ count: sql<number>`count(*)` })
        .from(apps)
        .where(eq(apps.status, "active")),
      activePeople(day, day),
      activePeople(weekStart, day),
      appUse(day),
    ]);
  if (!installed) return null;
  return {
    schema: 1,
    install: input.install,
    day,
    version: input.version,
    installed,
    members: roundDown(Number(memberCount[0]?.count ?? 0), MEMBER_CAP),
    active_members_1d: roundDown(activeDay.size, MEMBER_CAP),
    active_members_7d: roundDown(activeWeek.size, MEMBER_CAP),
    apps: roundDown(Number(appCount[0]?.count ?? 0)),
    app_use_1d: use,
  };
}
