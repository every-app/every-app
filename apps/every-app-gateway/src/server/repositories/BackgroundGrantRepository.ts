import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  apps,
  members,
  providerBackgroundGrants,
  providerConnections,
  users,
} from "@/db/schema";
import { effectiveAccess } from "./effective-access";

/**
 * Members' background opt-ins (docs/design/2026-11-birds-decisions/888-background-oauth.md):
 * one row per (connection, app), live while `ended_at` is null. Rows that
 * ended stay, so a grant made again reuses its row (and its id, which the
 * audit log names).
 */

/** Why a grant ended. */
export type BackgroundGrantEnd =
  | "revoked"
  | "admin_revoked"
  | "idle"
  | "no_access"
  | "member_inactive"
  | "app_removed"
  | "disconnected";

export interface BackgroundGrant {
  id: string;
  organizationId: string;
  providerId: string;
  connectionId: string;
  appRowId: string;
  userId: string;
  scopeSets: string[];
  grantedAt: number;
  lastSeenAt: number;
  lastUsedAt: number | null;
  endedAt: number | null;
  endedReason: string | null;
}

/** A live grant as Settings and Manage workspace list it. */
interface ListedBackgroundGrant extends BackgroundGrant {
  app: { id: string; name: string };
  user: { email: string | null; name: string | null };
  connectionLabel: string | null;
}

const columns = {
  id: providerBackgroundGrants.id,
  organizationId: providerBackgroundGrants.organizationId,
  providerId: providerBackgroundGrants.providerId,
  connectionId: providerBackgroundGrants.connectionId,
  appRowId: providerBackgroundGrants.appRowId,
  userId: providerBackgroundGrants.userId,
  scopeSets: providerBackgroundGrants.scopeSets,
  grantedAt: providerBackgroundGrants.grantedAt,
  lastSeenAt: providerBackgroundGrants.lastSeenAt,
  lastUsedAt: providerBackgroundGrants.lastUsedAt,
  endedAt: providerBackgroundGrants.endedAt,
  endedReason: providerBackgroundGrants.endedReason,
};

type Row = Pick<
  typeof providerBackgroundGrants.$inferSelect,
  keyof typeof columns
>;

function strings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

const ms = (value: Date | null | undefined): number | null =>
  value ? value.getTime() : null;

function shape(row: Row): BackgroundGrant {
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerId: row.providerId,
    connectionId: row.connectionId,
    appRowId: row.appRowId,
    userId: row.userId,
    scopeSets: strings(row.scopeSets),
    grantedAt: row.grantedAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
    lastUsedAt: ms(row.lastUsedAt),
    endedAt: ms(row.endedAt),
    endedReason: row.endedReason,
  };
}

/**
 * Record a member's opt-in for one app on one connection: a new row, or
 * the pair's earlier row made live again with these sets. The live grant.
 */
async function grant(input: {
  organizationId: string;
  providerId: string;
  connectionId: string;
  appRowId: string;
  userId: string;
  scopeSets: readonly string[];
  now?: Date;
}): Promise<BackgroundGrant> {
  const now = input.now ?? new Date();
  const sets = JSON.stringify([...input.scopeSets]);
  const [row] = await db
    .insert(providerBackgroundGrants)
    .values({
      id: `bgg_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      providerId: input.providerId,
      connectionId: input.connectionId,
      appRowId: input.appRowId,
      userId: input.userId,
      scopeSets: sets,
      grantedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [
        providerBackgroundGrants.connectionId,
        providerBackgroundGrants.appRowId,
      ],
      set: {
        scopeSets: sets,
        grantedAt: now,
        lastSeenAt: now,
        endedAt: null,
        endedReason: null,
        endedBy: null,
      },
      // The pair is one person's connection to one app: never another's.
      setWhere: and(
        eq(providerBackgroundGrants.userId, input.userId),
        eq(providerBackgroundGrants.organizationId, input.organizationId),
      ),
    })
    .returning(columns);
  if (!row) throw new Error("background grant was not written");
  return shape(row);
}

/** The live grant for a connection and an app, or null. */
async function findLive(
  connectionId: string,
  appRowId: string,
): Promise<BackgroundGrant | null> {
  const [row] = await db
    .select(columns)
    .from(providerBackgroundGrants)
    .where(
      and(
        eq(providerBackgroundGrants.connectionId, connectionId),
        eq(providerBackgroundGrants.appRowId, appRowId),
        isNull(providerBackgroundGrants.endedAt),
      ),
    )
    .limit(1);
  return row ? shape(row) : null;
}

async function byId(id: string): Promise<BackgroundGrant | null> {
  const [row] = await db
    .select(columns)
    .from(providerBackgroundGrants)
    .where(eq(providerBackgroundGrants.id, id))
    .limit(1);
  return row ? shape(row) : null;
}

const listedColumns = {
  ...columns,
  appSlug: apps.appSlug,
  appName: apps.name,
  email: users.email,
  name: users.name,
  connectionLabel: providerConnections.label,
};

function listed(
  row: Row & {
    appSlug: string | null;
    appName: string | null;
    email: string | null;
    name: string | null;
    connectionLabel: string | null;
  },
): ListedBackgroundGrant {
  return {
    ...shape(row),
    app: {
      id: row.appSlug ?? "unknown",
      name: row.appName ?? row.appSlug ?? "an app",
    },
    user: { email: row.email ?? null, name: row.name ?? null },
    connectionLabel: row.connectionLabel ?? null,
  };
}

function listQuery() {
  return db
    .select(listedColumns)
    .from(providerBackgroundGrants)
    .leftJoin(apps, eq(apps.id, providerBackgroundGrants.appRowId))
    .leftJoin(users, eq(users.id, providerBackgroundGrants.userId))
    .leftJoin(
      providerConnections,
      eq(providerConnections.id, providerBackgroundGrants.connectionId),
    );
}

/** A member's live grants in one organization, oldest first. */
async function listForUser(
  userId: string,
  organizationId: string,
): Promise<ListedBackgroundGrant[]> {
  const rows = await listQuery()
    .where(
      and(
        eq(providerBackgroundGrants.userId, userId),
        eq(providerBackgroundGrants.organizationId, organizationId),
        isNull(providerBackgroundGrants.endedAt),
      ),
    )
    .orderBy(
      asc(providerBackgroundGrants.grantedAt),
      asc(providerBackgroundGrants.id),
    );
  return rows.map(listed);
}

/** Every live grant in an organization, oldest first. */
async function listForOrganization(
  organizationId: string,
): Promise<ListedBackgroundGrant[]> {
  const rows = await listQuery()
    .where(
      and(
        eq(providerBackgroundGrants.organizationId, organizationId),
        isNull(providerBackgroundGrants.endedAt),
      ),
    )
    .orderBy(
      asc(providerBackgroundGrants.grantedAt),
      asc(providerBackgroundGrants.id),
    );
  return rows.map(listed);
}

/**
 * End a live grant; the grant as it was, or null when it wasn't live (so
 * of two ends at once, one records the event).
 */
async function end(
  id: string,
  input: { reason: BackgroundGrantEnd; by?: string | null; now?: Date },
): Promise<BackgroundGrant | null> {
  const [row] = await db
    .update(providerBackgroundGrants)
    .set({
      endedAt: input.now ?? new Date(),
      endedReason: input.reason,
      endedBy: input.by ?? null,
    })
    .where(
      and(
        eq(providerBackgroundGrants.id, id),
        isNull(providerBackgroundGrants.endedAt),
      ),
    )
    .returning(columns);
  return row ? shape(row) : null;
}

/**
 * The member opened the app: the live grants' `last_seen_at`, for those
 * last touched more than `staleMs` ago (once a day). The rows touched.
 */
async function touchSeen(input: {
  userId: string;
  appRowId: string;
  now?: Date;
  staleMs: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const touched = await db
    .update(providerBackgroundGrants)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(providerBackgroundGrants.userId, input.userId),
        eq(providerBackgroundGrants.appRowId, input.appRowId),
        isNull(providerBackgroundGrants.endedAt),
        lt(
          providerBackgroundGrants.lastSeenAt,
          new Date(now.getTime() - input.staleMs),
        ),
      ),
    )
    .returning({ id: providerBackgroundGrants.id });
  return touched.length;
}

async function touchUsed(id: string, now: Date = new Date()): Promise<void> {
  await db
    .update(providerBackgroundGrants)
    .set({ lastUsedAt: now })
    .where(eq(providerBackgroundGrants.id, id));
}

/**
 * The live grants that should end, each with why, at most `limit`: unseen
 * since `idleBefore`; the connection gone; the app deleted, disabled or
 * not the organization's own; the member gone from the organization or
 * deactivated; or the member no longer opens the app.
 */
async function toLapse(input: {
  idleBefore: Date;
  now?: Date;
  limit?: number;
}): Promise<{ grant: BackgroundGrant; reason: BackgroundGrantEnd }[]> {
  const now = (input.now ?? new Date()).getTime();
  const rows = await db
    .select({
      ...columns,
      connection: providerConnections.id,
      connectionUser: providerConnections.userId,
      appStatus: apps.status,
      appScope: apps.scope,
      appOrganizationId: apps.organizationId,
      member: members.id,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(providerBackgroundGrants)
    .leftJoin(
      providerConnections,
      eq(providerConnections.id, providerBackgroundGrants.connectionId),
    )
    .leftJoin(apps, eq(apps.id, providerBackgroundGrants.appRowId))
    .leftJoin(
      members,
      and(
        eq(members.userId, providerBackgroundGrants.userId),
        eq(members.organizationId, providerBackgroundGrants.organizationId),
      ),
    )
    .leftJoin(users, eq(users.id, providerBackgroundGrants.userId))
    .where(isNull(providerBackgroundGrants.endedAt))
    .orderBy(asc(providerBackgroundGrants.id))
    .limit(input.limit ?? 1000);
  const out: { grant: BackgroundGrant; reason: BackgroundGrantEnd }[] = [];
  const access: BackgroundGrant[] = [];
  for (const row of rows) {
    const grant = shape(row);
    const banned =
      row.banned === true &&
      (!row.banExpires || row.banExpires.getTime() > now);
    const reason: BackgroundGrantEnd | null =
      !row.connection || row.connectionUser !== grant.userId
        ? "disconnected"
        : !row.appStatus ||
            row.appStatus === "deleted" ||
            row.appStatus === "disabled" ||
            row.appScope !== "org" ||
            row.appOrganizationId !== grant.organizationId
          ? "app_removed"
          : !row.member || banned
            ? "member_inactive"
            : grant.lastSeenAt < input.idleBefore.getTime()
              ? "idle"
              : null;
    if (reason) out.push({ grant, reason });
    else access.push(grant);
  }
  // Access, per organization: one query each over the access rule.
  const byOrg = new Map<string, BackgroundGrant[]>();
  for (const grant of access) {
    byOrg.set(grant.organizationId, [
      ...(byOrg.get(grant.organizationId) ?? []),
      grant,
    ]);
  }
  for (const [organizationId, grants] of byOrg) {
    const holders = await hasAccess(
      organizationId,
      grants.map((grant) => ({
        userId: grant.userId,
        appRowId: grant.appRowId,
      })),
    );
    for (const grant of grants) {
      if (!holders.has(`${grant.userId}\u0000${grant.appRowId}`)) {
        out.push({ grant, reason: "no_access" });
      }
    }
  }
  return out;
}

/** Which of the (user, app) pairs hold access in the organization, as `user\0app` keys. */
async function hasAccess(
  organizationId: string,
  pairs: readonly { userId: string; appRowId: string }[],
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const access = effectiveAccess(organizationId);
  const rows = await db
    .select({ userId: access.userId, appRowId: access.appRowId })
    .from(access)
    .where(
      and(
        inArray(
          access.userId,
          pairs.map((pair) => pair.userId),
        ),
        inArray(
          access.appRowId,
          pairs.map((pair) => pair.appRowId),
        ),
      ),
    );
  return new Set(rows.map((row) => `${row.userId}\u0000${row.appRowId}`));
}

/** Whether the member is in the organization, not deactivated, and opens the app. */
async function memberMayUse(input: {
  organizationId: string;
  userId: string;
  appRowId: string;
  now?: number;
}): Promise<boolean> {
  const [row] = await db
    .select({ banned: users.banned, banExpires: users.banExpires })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, input.organizationId),
        eq(members.userId, input.userId),
      ),
    )
    .limit(1);
  if (!row) return false;
  const now = input.now ?? Date.now();
  if (row.banned && (!row.banExpires || row.banExpires.getTime() > now)) {
    return false;
  }
  const holders = await hasAccess(input.organizationId, [
    { userId: input.userId, appRowId: input.appRowId },
  ]);
  return holders.size > 0;
}

/** The live grants on one connection (ended when it is disconnected). */
async function liveForConnection(
  connectionId: string,
): Promise<BackgroundGrant[]> {
  const rows = await db
    .select(columns)
    .from(providerBackgroundGrants)
    .where(
      and(
        eq(providerBackgroundGrants.connectionId, connectionId),
        isNull(providerBackgroundGrants.endedAt),
      ),
    );
  return rows.map(shape);
}

/** Count of live grants per provider in an organization (Manage workspace → Providers). */
async function countLiveByProvider(
  organizationId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      providerId: providerBackgroundGrants.providerId,
      count: sql<number>`count(*)`,
    })
    .from(providerBackgroundGrants)
    .where(
      and(
        eq(providerBackgroundGrants.organizationId, organizationId),
        isNull(providerBackgroundGrants.endedAt),
      ),
    )
    .groupBy(providerBackgroundGrants.providerId);
  return Object.fromEntries(
    rows.map((row) => [row.providerId, Number(row.count)]),
  );
}

export const BackgroundGrantRepository = {
  grant,
  findLive,
  byId,
  listForUser,
  listForOrganization,
  end,
  touchSeen,
  touchUsed,
  toLapse,
  memberMayUse,
  liveForConnection,
  countLiveByProvider,
} as const;
