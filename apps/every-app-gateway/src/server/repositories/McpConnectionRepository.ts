import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
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
/**
 * "mcp": an AI app at the gateway's /mcp; "native": a native app on one app
 * host; "dev": `everyapp dev --gateway` using the Gateway's services for
 * one app (docs/design/linked-dev.md).
 */
type McpConnectionKind = "mcp" | "native" | "dev";
/** The kinds bound to one app: one `mcp_connection_apps` row, and the app's fate is theirs. */
const APP_BOUND_KINDS: readonly McpConnectionKind[] = ["native", "dev"];
type RevokedReason =
  | "user"
  | "superseded"
  | "member_removed"
  | "user_deactivated"
  | "expired"
  | "ended"
  | "failed"
  | "app_removed";

type CreateConnectionInput = {
  id: string;
  /** "mcp" unless said. */
  kind?: McpConnectionKind;
  /** The grant's audience: `${issuer}/mcp`, or the app host's origin. */
  resource?: string | null;
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
        kind: input.kind ?? "mcp",
        resource: input.resource ?? null,
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
 * Retire the user's active connections of the same kind through the same
 * client in the same organization made before `connection`, from the
 * installations `sameInstallation` accepts (by their redirect URI), as
 * superseded; returns their ids. A native connection retires only those
 * for the same app (the same resource): one client may be signed in to
 * two apps. Only connections made before this one: of two consents
 * completing at once, neither retires the other's row. Only this
 * organization's: a member of two connects the same client to each, and
 * connecting one never cuts off the other.
 */
async function supersedeEarlier(
  connection: {
    kind?: McpConnectionKind;
    resource?: string | null;
    userId: string;
    organizationId: string;
    clientId: string;
    createdAt: Date;
  },
  sameInstallation: (redirectUri: string) => boolean,
): Promise<RevokedConnection[]> {
  const kind = connection.kind ?? "mcp";
  const earlier = await db
    .select({ ...revokedColumns(), redirectUri: mcpConnections.redirectUri })
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.userId, connection.userId),
        eq(mcpConnections.organizationId, connection.organizationId),
        eq(mcpConnections.clientId, connection.clientId),
        eq(mcpConnections.kind, kind),
        ...(APP_BOUND_KINDS.includes(kind)
          ? [eq(mcpConnections.resource, connection.resource ?? "")]
          : []),
        lt(mcpConnections.createdAt, connection.createdAt),
        isNull(mcpConnections.revokedAt),
      ),
    );
  const superseded = earlier
    .filter((row) => sameInstallation(row.redirectUri))
    .map(({ redirectUri: _redirectUri, ...row }) => row);
  for (const batch of chunk(
    superseded.map((row) => row.id),
    IDS_PER_STATEMENT,
  )) {
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
  return superseded;
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
      kind: mcpConnections.kind,
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
 * An active app-bound connection (native by default, or dev) with what
 * every request re-checks (as {@link findActiveWithMembership}), and the
 * one app it opens. Null for a connection of another kind, a revoked one,
 * or one whose app row was taken out of it (the app deleted:
 * AppRepository.tombstone).
 */
async function findActiveNativeWithMembership(
  id: string,
  kind: "native" | "dev" = "native",
) {
  const [row] = await db
    .select({
      id: mcpConnections.id,
      userId: mcpConnections.userId,
      organizationId: mcpConnections.organizationId,
      clientName: mcpConnections.clientName,
      clientDomain: mcpConnections.clientDomain,
      resource: mcpConnections.resource,
      createdAt: mcpConnections.createdAt,
      lastUsedAt: mcpConnections.lastUsedAt,
      appRowId: mcpConnectionApps.appRowId,
      role: members.role,
      memberSince: members.createdAt,
      email: users.email,
      banned: users.banned,
      banExpires: users.banExpires,
      organizationName: organizations.name,
      organizationStatus: organizations.status,
    })
    .from(mcpConnections)
    .innerJoin(
      mcpConnectionApps,
      eq(mcpConnectionApps.connectionId, mcpConnections.id),
    )
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
    .where(
      and(
        eq(mcpConnections.id, id),
        eq(mcpConnections.kind, kind),
        isNull(mcpConnections.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * An active first-party app row by id, with what a dev grant's checks
 * read (docs/design/linked-dev.md): its slug, organization, scope and
 * Worker name. Null when gone, inactive or not first-party.
 */
async function findActiveAppRow(appRowId: string) {
  const [row] = await db
    .select({
      rowId: apps.id,
      organizationId: apps.organizationId,
      appSlug: apps.appSlug,
      name: apps.name,
      hostname: apps.hostname,
      workerName: apps.workerName,
      scope: apps.scope,
    })
    .from(apps)
    .where(
      and(
        eq(apps.id, appRowId),
        eq(apps.status, "active"),
        eq(apps.tier, "service_binding"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The active first-party apps with `slug` (one per organization at most),
 * the ones a dev grant's resource may name.
 */
async function findActiveAppsBySlug(slug: string) {
  return db
    .select({
      rowId: apps.id,
      organizationId: apps.organizationId,
      appSlug: apps.appSlug,
      name: apps.name,
      hostname: apps.hostname,
      scope: apps.scope,
    })
    .from(apps)
    .where(
      and(
        eq(apps.appSlug, slug),
        eq(apps.status, "active"),
        eq(apps.tier, "service_binding"),
      ),
    );
}

/**
 * The resource (origin on `scheme`) of an active first-party app row, or
 * null when the row is gone, not active, or not a first-party host.
 */
async function findAppResource(
  appRowId: string,
  scheme: "https:" | "http:",
): Promise<string | null> {
  const [row] = await db
    .select({ hostname: apps.hostname })
    .from(apps)
    .where(
      and(
        eq(apps.id, appRowId),
        eq(apps.status, "active"),
        eq(apps.tier, "service_binding"),
        isNotNull(apps.hostname),
      ),
    )
    .limit(1);
  return row?.hostname ? `${scheme}//${row.hostname.toLowerCase()}` : null;
}

/**
 * The active first-party app serving `hostname` (the one a native grant's
 * resource names), with what the consent page shows and records; null for
 * an unknown, inactive or third-party host.
 */
async function findActiveAppByHostname(hostname: string) {
  const [row] = await db
    .select({
      rowId: apps.id,
      organizationId: apps.organizationId,
      appSlug: apps.appSlug,
      name: apps.name,
      hostname: apps.hostname,
      scope: apps.scope,
    })
    .from(apps)
    .where(
      and(
        eq(apps.hostname, hostname),
        eq(apps.status, "active"),
        eq(apps.tier, "service_binding"),
      ),
    )
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
        kind: mcpConnections.kind,
        resource: mcpConnections.resource,
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
        hostname: apps.hostname,
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
    // An app-bound connection's one app, with its host; null once the app
    // row left the connection (deleted) or for an MCP connection.
    app: APP_BOUND_KINDS.includes(connection.kind as McpConnectionKind)
      ? (connectionApps
          .filter((app) => app.connectionId === connection.id)
          .map((app) => ({ name: app.name, hostname: app.hostname }))[0] ??
        null)
      : null,
  }));
}

/** What every revoke returns about each row it revoked: enough for the event. */
export type RevokedConnection = {
  id: string;
  kind: string;
  userId: string;
  organizationId: string;
  clientName: string;
};

/** Built per call: tests that stub the schema never load these columns. */
const revokedColumns = () => ({
  id: mcpConnections.id,
  kind: mcpConnections.kind,
  userId: mcpConnections.userId,
  organizationId: mcpConnections.organizationId,
  clientName: mcpConnections.clientName,
});

/** A native connection's one app (for its events); null once the row left it. */
async function findConnectionApp(connectionId: string) {
  const [row] = await db
    .select({ rowId: apps.id, id: apps.appSlug, name: apps.name })
    .from(mcpConnectionApps)
    .innerJoin(apps, eq(apps.id, mcpConnectionApps.appRowId))
    .where(eq(mcpConnectionApps.connectionId, connectionId))
    .limit(1);
  return row ?? null;
}

/** Revoke one of a user's connections; null when it isn't theirs or active. */
async function revokeForUser(
  id: string,
  userId: string,
  reason: RevokedReason,
): Promise<RevokedConnection | null> {
  const [revoked] = await db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedBy: userId, revokedReason: reason })
    .where(
      and(
        eq(mcpConnections.id, id),
        eq(mcpConnections.userId, userId),
        isNull(mcpConnections.revokedAt),
      ),
    )
    .returning(revokedColumns());
  return revoked ?? null;
}

/**
 * Revoke a connection that can't work any more: its member is gone, its
 * grant ended, or its authorization never completed. The row, or null
 * when it was revoked already.
 */
async function revokeById(
  id: string,
  reason: RevokedReason,
): Promise<RevokedConnection | null> {
  const [revoked] = await db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(mcpConnections.id, id), isNull(mcpConnections.revokedAt)))
    .returning(revokedColumns());
  return revoked ?? null;
}

/**
 * Revoke a user's active connections, in one organization or all of them
 * (member removal, deactivation); the rows revoked.
 */
async function revokeAllForUser(
  userId: string,
  reason: RevokedReason,
  organizationId?: string,
): Promise<RevokedConnection[]> {
  return db
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
    )
    .returning(revokedColumns());
}

/**
 * Revoke the active native and dev connections to one app (the app
 * deleted or disabled); the rows revoked. App-bound rows only: an MCP
 * connection that chose the app among others keeps its other apps.
 */
async function revokeNativeForApp(
  appRowId: string,
  reason: RevokedReason,
): Promise<RevokedConnection[]> {
  return db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(
      and(
        inArray(mcpConnections.kind, [...APP_BOUND_KINDS]),
        isNull(mcpConnections.revokedAt),
        inArray(
          mcpConnections.id,
          db
            .select({ id: mcpConnectionApps.connectionId })
            .from(mcpConnectionApps)
            .where(eq(mcpConnectionApps.appRowId, appRowId)),
        ),
      ),
    )
    .returning(revokedColumns());
}

/**
 * Revoke every active native connection whose app is no longer an active
 * first-party host, or whose app row left it (the hourly maintenance: the
 * CLI deletes and disables apps by writing the registry, where no service
 * runs; their tokens are refused as soon as the origin leaves the resource
 * list, and this keeps the list of connections honest). The rows revoked.
 */
async function revokeNativeForInactiveApps(): Promise<RevokedConnection[]> {
  const live = db
    .select({ id: mcpConnectionApps.connectionId })
    .from(mcpConnectionApps)
    .innerJoin(apps, eq(apps.id, mcpConnectionApps.appRowId))
    .where(
      and(
        eq(apps.status, "active"),
        eq(apps.tier, "service_binding"),
        isNotNull(apps.hostname),
      ),
    );
  return db
    .update(mcpConnections)
    .set({ revokedAt: new Date(), revokedReason: "app_removed" })
    .where(
      and(
        inArray(mcpConnections.kind, [...APP_BOUND_KINDS]),
        isNull(mcpConnections.revokedAt),
        notInArray(mcpConnections.id, live),
      ),
    )
    .returning(revokedColumns());
}

/**
 * Expire active connections unused since `cutoff` (never-used ones count
 * from their creation). Their grants have lapsed in the authorization server
 * by then; this keeps the list of connections honest. The rows expired.
 */
async function expireUnusedSince(cutoff: Date): Promise<RevokedConnection[]> {
  return db
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
    .returning(revokedColumns());
}

export const McpConnectionRepository = {
  create,
  supersedeEarlier,
  listChoicesForUser,
  findActiveWithMembership,
  findActiveNativeWithMembership,
  findActiveAppRow,
  findActiveAppsBySlug,
  findConnectionApp,
  findAppResource,
  findActiveAppByHostname,
  touchLastUsed,
  listActiveForUser,
  revokeForUser,
  revokeById,
  revokeAllForUser,
  revokeNativeForApp,
  revokeNativeForInactiveApps,
  expireUnusedSince,
} as const;
