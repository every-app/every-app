/**
 * The usage report: everything a Gateway sends us, built here and nowhere
 * else (https://everyapp.com/docs/telemetry; apps/telemetry receives it).
 *
 * Counts only, each rounded down to one significant digit, from tables the
 * Gateway already keeps. It reads ids, roles, timestamps, app slugs and
 * whether an app row is an MCP server. It
 * never reads a name, an email, a hostname, a manifest, a tool's name, a
 * secret, or `_everyapp_install` (the account, the zone and the Gateway's
 * host): payload.test.ts fails if this file names one of those columns,
 * and if the report's keys differ from apps/telemetry/example-report.json.
 */
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
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
 * The apps of ours a report names, by manifest id: the ones our public
 * docs list. apps/telemetry's `APPS` is the same list plus "other".
 */
export const NAMED_APPS: readonly string[] = [
  "openseo",
  "crm",
  "openmail",
  "analytics",
  "scribe",
  "repolens",
];

/**
 * Every other deployed app: the operator's own, and nothing else. We see
 * that an app of theirs is used, never what it is.
 */
const OTHER = "other";

/** `members` and the active counts stop here: a very large team would stand out. */
const MEMBER_CAP = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AppUse {
  app: string;
  active_members: number;
  tool_calls: number;
}

interface McpUse {
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
  /** Deployed apps that are active. MCP servers are not among them. */
  apps: number;
  /** MCP servers connected and turned on: remote ones by URL and the built-in ones. */
  mcp_servers: number;
  /** One row per app of ours used that day, and one, "other", for all of the operator's own. */
  app_use_1d: AppUse[];
  /** Use of the MCP servers that day, all of them together and none named. */
  mcp_use_1d: McpUse;
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

/**
 * Use on `day`, by what was used: each app of ours by name, the
 * operator's own apps together as "other", and the MCP servers together.
 * For each, the members behind its tool calls and provider calls, and its
 * tool calls. A tool call counts whichever way the AI client reached the
 * tool (the app's own MCP endpoint or the Gateway's). A call with no app
 * behind it (the Gateway's own tools, or an app whose row is gone) is in
 * none of them: it is not use of an app.
 */
async function useByKind(
  day: string,
): Promise<{ apps: AppUse[]; mcp: McpUse }> {
  const from = new Date(`${day}T00:00:00Z`);
  const until = new Date(from.getTime() + DAY_MS);
  const [rows, toolCalls, providerCalls] = await Promise.all([
    db.select({ id: apps.id, slug: apps.appSlug, tier: apps.tier }).from(apps),
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
  const MCP = "mcp servers";
  const kindOf = new Map(
    rows.map((row) => [
      row.id,
      row.tier === PROVIDER_APP_TIER
        ? MCP
        : NAMED_APPS.includes(row.slug)
          ? row.slug
          : OTHER,
    ]),
  );
  const use = new Map<string, { people: Set<string>; calls: number }>();
  const entry = (appRowId: string | null) => {
    const kind = appRowId ? kindOf.get(appRowId) : undefined;
    if (!kind) return null;
    const found = use.get(kind) ?? { people: new Set<string>(), calls: 0 };
    use.set(kind, found);
    return found;
  };
  for (const row of toolCalls) {
    const used = entry(row.appRowId);
    if (!used) continue;
    used.people.add(row.user);
    used.calls += Number(row.calls);
  }
  for (const row of providerCalls) {
    // '' is the app's own background work: use, with nobody behind it.
    if (row.user) entry(row.appRowId)?.people.add(row.user);
    else entry(row.appRowId);
  }
  const counts = (kind: string) => ({
    active_members: roundDown(use.get(kind)?.people.size ?? 0, MEMBER_CAP),
    tool_calls: roundDown(use.get(kind)?.calls ?? 0),
  });
  return {
    apps: [...NAMED_APPS, OTHER]
      .filter((app) => use.has(app))
      .map((app) => ({ app, ...counts(app) })),
    mcp: counts(MCP),
  };
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
  const [installed, memberCount, activeRows, activeDay, activeWeek, use] =
    await Promise.all([
      installedMonth(),
      db
        .select({ count: sql<number>`count(distinct ${members.userId})` })
        .from(members),
      db
        .select({ tier: apps.tier, count: sql<number>`count(*)` })
        .from(apps)
        .where(eq(apps.status, "active"))
        .groupBy(apps.tier),
      activePeople(day, day),
      activePeople(weekStart, day),
      useByKind(day),
    ]);
  if (!installed) return null;
  const active = (mcp: boolean) =>
    activeRows
      .filter((row) => (row.tier === PROVIDER_APP_TIER) === mcp)
      .reduce((sum, row) => sum + Number(row.count), 0);
  return {
    schema: 1,
    install: input.install,
    day,
    version: input.version,
    installed,
    members: roundDown(Number(memberCount[0]?.count ?? 0), MEMBER_CAP),
    active_members_1d: roundDown(activeDay.size, MEMBER_CAP),
    active_members_7d: roundDown(activeWeek.size, MEMBER_CAP),
    apps: roundDown(active(false)),
    mcp_servers: roundDown(active(true)),
    app_use_1d: use.apps,
    mcp_use_1d: use.mcp,
  };
}
