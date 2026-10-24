import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  apps,
  appToolCatalogs,
  mcpConnectionApps,
  mcpConnections,
  members,
  organizations,
  users,
} from "@/db/schema";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { accessToAppInItsOrganization } from "./effective-access";

type McpConnectionAccess = "read" | "write";
type McpConnectionAppScope = "all" | "selected";
type RevokedReason =
  | "user"
  | "superseded"
  | "member_removed"
  | "user_deactivated"
  | "expired"
  | "ended"
  | "failed";

type CreateConnectionInput = {
  id: string;
  userId: string;
  organizationId: string;
  clientId: string;
  clientName: string;
  clientDomain: string | null;
  redirectUri: string;
  redirectHost: string;
  appScope: McpConnectionAppScope;
  appRowIds: string[];
  access: McpConnectionAccess;
  createdAt: Date;
};

/** A connection's last use is written at most this often. */
const LAST_USED_RESOLUTION_MS = 10 * 60_000;
// D1 binds at most 100 parameters per statement; a connection app row has 2.
const APP_ROWS_PER_INSERT = 40;
const IDS_PER_STATEMENT = 90;

/**
 * Store a new connection and its apps in one D1 transaction. False, and
 * nothing written, when a connection with this id exists already.
 */
async function create(input: CreateConnectionInput): Promise<boolean> {
  try {
    await db.batch([
      db.insert(mcpConnections).values({
        id: input.id,
        userId: input.userId,
        organizationId: input.organizationId,
        clientId: input.clientId,
        clientName: input.clientName,
        clientDomain: input.clientDomain,
        redirectUri: input.redirectUri,
        redirectHost: input.redirectHost,
        appScope: input.appScope,
        access: input.access,
        createdAt: input.createdAt,
      }),
      ...chunk(input.appRowIds, APP_ROWS_PER_INSERT).map((appRowIds) =>
        db
          .insert(mcpConnectionApps)
          .values(
            appRowIds.map((appRowId) => ({ connectionId: input.id, appRowId })),
          ),
      ),
    ]);
    return true;
  } catch (error) {
    // The transaction wrote nothing; a row with this id means it collided
    // with one (D1 names no constraint a caller could match reliably).
    const [existing] = await db
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, input.id))
      .limit(1);
    if (existing) return false;
    throw error;
  }
}

/**
 * Retire the user's active connections through the same client in the same
 * organization made before `connection`, from the installations
 * `sameInstallation` accepts (by their redirect URI), as superseded; returns
 * their ids. Only connections made before this one: of two consents
 * completing at once, neither retires the other's row. Only this
 * organization's: a member of two connects the same client to each, and
 * connecting one never cuts off the other.
 */
async function supersedeEarlier(
  connection: {
    userId: string;
    organizationId: string;
    clientId: string;
    createdAt: Date;
  },
  sameInstallation: (redirectUri: string) => boolean,
): Promise<string[]> {
  const earlier = await db
    .select({ id: mcpConnections.id, redirectUri: mcpConnections.redirectUri })
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.userId, connection.userId),
        eq(mcpConnections.organizationId, connection.organizationId),
        eq(mcpConnections.clientId, connection.clientId),
        lt(mcpConnections.createdAt, connection.createdAt),
        isNull(mcpConnections.revokedAt),
      ),
    );
  const ids = earlier
    .filter((row) => sameInstallation(row.redirectUri))
    .map((row) => row.id);
  for (const batch of chunk(ids, IDS_PER_STATEMENT)) {
    await db
      .update(mcpConnections)
      .set({ revokedAt: new Date(), revokedReason: "superseded" })
      .where(
        and(
          inArray(mcpConnections.id, batch),
          isNull(mcpConnections.revokedAt),
        ),
      );
  }
  return ids;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * An active connection with what every /mcp request re-checks: the user's
 * current role in the connection's organization (null once they left it)
 * and since when they hold it, their ban state and email, and the
 * organization's name.
 */
async function findActiveWithMembership(id: string) {
  const [row] = await db
    .select({
      id: mcpConnections.id,
      userId: mcpConnections.userId,
      organizationId: mcpConnections.organizationId,
      clientName: mcpConnections.clientName,
      appScope: mcpConnections.appScope,
      access: mcpConnections.access,
      createdAt: mcpConnections.createdAt,
      lastUsedAt: mcpConnections.lastUsedAt,
      role: members.role,
      memberSince: members.createdAt,
      email: users.email,
      banned: users.banned,
      banExpires: users.banExpires,
      organizationName: organizations.name,
      organizationStatus: organizations.status,
    })
    .from(mcpConnections)
    .innerJoin(users, eq(users.id, mcpConnections.userId))
    .innerJoin(
      organizations,
      eq(organizations.id, mcpConnections.organizationId),
    )
    .leftJoin(
      members,
      and(
        eq(members.userId, mcpConnections.userId),
        eq(members.organizationId, mcpConnections.organizationId),
      ),
    )
    .where(and(eq(mcpConnections.id, id), isNull(mcpConnections.revokedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * What a user may connect an AI app to: their memberships (with the
 * organization's name and status), in each the active apps they have
 * access to (directly or through a group, the one rule every access site
 * reads), and the active shared apps, which any organization's members
 * may use on the hosted gateway; each with whether the app has tools to
 * serve.
 */
async function listChoicesForUser(userId: string) {
  // Routable, or a provider app the gateway serves itself.
  const usable = and(
    eq(apps.status, "active"),
    or(
      and(isNotNull(apps.hostname), isNotNull(apps.workerName)),
      eq(apps.tier, PROVIDER_APP_TIER),
    ),
  );
  const [memberships, accessibleApps, shared] = await db.batch([
    db
      .select({
        organizationId: members.organizationId,
        organizationName: organizations.name,
        organizationStatus: organizations.status,
        role: members.role,
      })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .where(eq(members.userId, userId))
      .orderBy(asc(organizations.name)),
    db
      .select({
        organizationId: apps.organizationId,
        appRowId: apps.id,
        appSlug: apps.appSlug,
        name: apps.name,
        catalogStatus: appToolCatalogs.status,
      })
      .from(apps)
      .leftJoin(appToolCatalogs, eq(appToolCatalogs.appRowId, apps.id))
      .where(and(usable, accessToAppInItsOrganization(userId)))
      .orderBy(asc(apps.name)),
    db
      .select({
        appRowId: apps.id,
        appSlug: apps.appSlug,
        name: apps.name,
        catalogStatus: appToolCatalogs.status,
      })
      .from(apps)
      .leftJoin(appToolCatalogs, eq(appToolCatalogs.appRowId, apps.id))
      .where(and(usable, eq(apps.scope, "shared")))
      .orderBy(asc(apps.name)),
  ]);
  return { memberships, accessibleApps, sharedApps: shared };
}

/** Note a use, unless one was noted in the last ten minutes. */
async function touchLastUsed(id: string, now = new Date()): Promise<void> {
  await db
    .update(mcpConnections)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(mcpConnections.id, id),
        or(
          isNull(mcpConnections.lastUsedAt),
          lt(
            mcpConnections.lastUsedAt,
            new Date(now.getTime() - LAST_USED_RESOLUTION_MS),
          ),
        ),
      ),
    );
}

/** A user's active connections, newest first, with their apps by name. */
async function listActiveForUser(userId: string) {
  const [connections, connectionApps] = await db.batch([
    db
      .select({
        id: mcpConnections.id,
        organizationId: mcpConnections.organizationId,
        organizationName: organizations.name,
        clientId: mcpConnections.clientId,
        clientName: mcpConnections.clientName,
        clientDomain: mcpConnections.clientDomain,
        redirectHost: mcpConnections.redirectHost,
        appScope: mcpConnections.appScope,
        access: mcpConnections.access,
        createdAt: mcpConnections.createdAt,
        lastUsedAt: mcpConnections.lastUsedAt,
      })
      .from(mcpConnections)
      .innerJoin(
        organizations,
        eq(organizations.id, mcpConnections.organizationId),
      )
      .where(
        and(
          eq(mcpConnections.userId, userId),
          isNull(mcpConnections.revokedAt),
        ),
      )
      .orderBy(desc(mcpConnections.createdAt)),
    db
      .select({
        connectionId: mcpConnectionApps.connectionId,
        name: apps.name,
      })
      .from(mcpConnectionApps)
      .innerJoin(
        mcpConnections,
        eq(mcpConnections.id, mcpConnectionApps.connectionId),
      )
      .innerJoin(apps, eq(apps.id, mcpConnectionApps.appRowId))
      .where(
        and(
          eq(mcpConnections.userId, userId),
          isNull(mcpConnections.revokedAt),
        ),
      )
      .orderBy(asc(apps.name)),
  ]);
  return connections.map((connection) => ({
    ...connection,
    appNames: connectionApps
      .filter((app) => app.connectionId === connection.id)
      .map((app) => app.name),
  }));
}

/** Revoke one of a user's connections; false when it isn't theirs or active. */
async function revokeForUser(
  id: string,
  userId: string,
  reason: RevokedReason,
): Promise<boolean> {
  const revoked = await db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedBy: userId, revokedReason: reason })
    .where(
      and(
        eq(mcpConnections.id, id),
        eq(mcpConnections.userId, userId),
        isNull(mcpConnections.revokedAt),
      ),
    )
    .returning({ id: mcpConnections.id });
  return revoked.length > 0;
}

/**
 * Revoke a connection that can't work any more: its member is gone, its
 * grant ended, or its authorization never completed.
 */
async function revokeById(id: string, reason: RevokedReason): Promise<void> {
  await db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(mcpConnections.id, id), isNull(mcpConnections.revokedAt)));
}

/**
 * Revoke a user's active connections, in one organization or all of them
 * (member removal, deactivation).
 */
async function revokeAllForUser(
  userId: string,
  reason: RevokedReason,
  organizationId?: string,
): Promise<void> {
  await db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(
        eq(mcpConnections.userId, userId),
        isNull(mcpConnections.revokedAt),
        ...(organizationId
          ? [eq(mcpConnections.organizationId, organizationId)]
          : []),
      ),
    );
}

/**
 * Expire active connections unused since `cutoff` (never-used ones count
 * from their creation). Their grants have lapsed in the authorization server
 * by then; this keeps the list of connections honest.
 */
async function expireUnusedSince(cutoff: Date): Promise<number> {
  const expired = await db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedReason: "expired" })
    .where(
      and(
        isNull(mcpConnections.revokedAt),
        lt(
          sql`coalesce(${mcpConnections.lastUsedAt}, ${mcpConnections.createdAt})`,
          cutoff.getTime(),
        ),
      ),
    )
    .returning({ id: mcpConnections.id });
  return expired.length;
}

export const McpConnectionRepository = {
  create,
  supersedeEarlier,
  listChoicesForUser,
  findActiveWithMembership,
  touchLastUsed,
  listActiveForUser,
  revokeForUser,
  revokeById,
  revokeAllForUser,
  expireUnusedSince,
} as const;
