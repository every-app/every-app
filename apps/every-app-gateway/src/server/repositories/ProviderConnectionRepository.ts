import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { apps, providerConnections } from "@/db/schema";
import { accessToApp } from "./effective-access";
import { open, seal, type SealingEnv } from "@/server/secrets/sealed";

/**
 * One person's connection to one OAuth provider, in one app
 * (docs/design/2026-11-oauth-simplify.md). Tokens are sealed on the way
 * in (`upsert`) and opened on the way out (`readTokens`); the listing
 * shapes never carry them. One row per (organization, provider, user,
 * app). The lifecycle deletes: a disconnect (`remove`), a member leaving
 * or deactivated (`removeForMember`), a member losing the app
 * (`removeForMemberApp`), the app deleted (`removeForApp`), the provider
 * removed (`removeAllForProvider`).
 */
type ConnectionStatus = "active" | "expired";

/** A connection as Settings, Admin and the CLI list it: no token. */
export interface ProviderConnection {
  id: string;
  organizationId: string;
  providerId: string;
  userId: string;
  /** apps.id of the app the person connected in. */
  appRowId: string;
  label: string | null;
  externalId: string | null;
  /** The scopes the token holds, canonical. */
  scopes: string[];
  expiresAt: number | null;
  status: ConnectionStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

/** The opened tokens of a connection, for the proxy and the refresh. */
interface ConnectionTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

const listed = {
  id: providerConnections.id,
  organizationId: providerConnections.organizationId,
  providerId: providerConnections.providerId,
  userId: providerConnections.userId,
  appRowId: providerConnections.appRowId,
  label: providerConnections.label,
  externalId: providerConnections.externalId,
  scopes: providerConnections.scopes,
  expiresAt: providerConnections.expiresAt,
  status: providerConnections.status,
  createdAt: providerConnections.createdAt,
  updatedAt: providerConnections.updatedAt,
  lastUsedAt: providerConnections.lastUsedAt,
};

type ListedRow = {
  id: string;
  organizationId: string;
  providerId: string;
  userId: string;
  appRowId: string;
  label: string | null;
  externalId: string | null;
  scopes: string;
  expiresAt: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

function strings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((each): each is string => typeof each === "string")
      : [];
  } catch {
    return [];
  }
}

function shape(row: ListedRow): ProviderConnection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerId: row.providerId,
    userId: row.userId,
    appRowId: row.appRowId,
    label: row.label,
    externalId: row.externalId,
    scopes: strings(row.scopes),
    expiresAt: row.expiresAt?.getTime() ?? null,
    status: row.status === "expired" ? "expired" : "active",
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
  };
}

/** The person's connection to the provider in the app, or null. */
async function find(input: {
  organizationId: string;
  providerId: string;
  userId: string;
  appRowId: string;
}): Promise<ProviderConnection | null> {
  const [row] = await db
    .select(listed)
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, input.organizationId),
        eq(providerConnections.providerId, input.providerId),
        eq(providerConnections.userId, input.userId),
        eq(providerConnections.appRowId, input.appRowId),
      ),
    )
    .limit(1);
  return row ? shape(row) : null;
}

async function byId(id: string): Promise<ProviderConnection | null> {
  const [row] = await db
    .select(listed)
    .from(providerConnections)
    .where(eq(providerConnections.id, id))
    .limit(1);
  return row ? shape(row) : null;
}

/** Every connection in an organization, oldest first. */
async function listByOrganization(
  organizationId: string,
): Promise<ProviderConnection[]> {
  const rows = await db
    .select(listed)
    .from(providerConnections)
    .where(eq(providerConnections.organizationId, organizationId))
    .orderBy(asc(providerConnections.createdAt), asc(providerConnections.id));
  return rows.map(shape);
}

/**
 * The app's active connection to a provider that was used most recently
 * (then the most recently updated), of any member: what lists a remote
 * MCP server's tools when no one in particular is calling. Null when
 * there is none.
 */
async function latestActiveForProvider(
  organizationId: string,
  providerId: string,
  appRowId: string,
): Promise<ProviderConnection | null> {
  const [row] = await db
    .select(listed)
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, organizationId),
        eq(providerConnections.providerId, providerId),
        eq(providerConnections.appRowId, appRowId),
        ne(providerConnections.status, "expired"),
      ),
    )
    .orderBy(
      sql`${providerConnections.lastUsedAt} IS NULL`,
      desc(providerConnections.lastUsedAt),
      desc(providerConnections.updatedAt),
    )
    .limit(1);
  return row ? shape(row) : null;
}

/** One person's own connections across organizations, oldest first. */
async function listByUser(userId: string): Promise<ProviderConnection[]> {
  const rows = await db
    .select(listed)
    .from(providerConnections)
    .where(eq(providerConnections.userId, userId))
    .orderBy(asc(providerConnections.createdAt), asc(providerConnections.id));
  return rows.map(shape);
}

/**
 * Write a connection, replacing the one the person had for the provider
 * in the app (a reconnect replaces tokens, scopes and label; the id and
 * `createdAt` stay). Tokens are sealed here.
 */
async function upsert(
  input: {
    organizationId: string;
    providerId: string;
    userId: string;
    appRowId: string;
    label: string | null;
    externalId: string | null;
    /** The scopes the token holds, canonical. */
    scopes: readonly string[];
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    now?: Date;
  },
  env: SealingEnv,
): Promise<ProviderConnection> {
  const now = input.now ?? new Date();
  const accessTokenEnc = await seal(input.accessToken, env);
  const refreshTokenEnc =
    input.refreshToken === null ? null : await seal(input.refreshToken, env);
  const values = {
    label: input.label,
    externalId: input.externalId,
    scopes: JSON.stringify([...input.scopes]),
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
    status: "active" as const,
    refreshingUntil: null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(providerConnections)
    .values({
      id: `conn_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      providerId: input.providerId,
      userId: input.userId,
      appRowId: input.appRowId,
      createdAt: now,
      lastUsedAt: null,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        providerConnections.organizationId,
        providerConnections.providerId,
        providerConnections.userId,
        providerConnections.appRowId,
      ],
      set: values,
    })
    .returning(listed);
  return shape(row!);
}

/** The opened tokens, or null when the row is gone or a token does not open (lost). */
async function readTokens(
  id: string,
  env: SealingEnv,
): Promise<ConnectionTokens | null> {
  const [row] = await db
    .select({
      accessTokenEnc: providerConnections.accessTokenEnc,
      refreshTokenEnc: providerConnections.refreshTokenEnc,
      expiresAt: providerConnections.expiresAt,
    })
    .from(providerConnections)
    .where(eq(providerConnections.id, id))
    .limit(1);
  if (!row) return null;
  const accessToken = await open(row.accessTokenEnc, env);
  if (accessToken === null) return null;
  let refreshToken: string | null = null;
  if (row.refreshTokenEnc !== null) {
    refreshToken = await open(row.refreshTokenEnc, env);
    if (refreshToken === null) return null;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: row.expiresAt?.getTime() ?? null,
  };
}

/**
 * Store the tokens a refresh returned and release the lease. A refresh
 * that returned no new refresh token keeps the old one (pass null).
 */
async function storeTokens(
  id: string,
  tokens: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    scopes?: readonly string[];
    now?: Date;
  },
  env: SealingEnv,
): Promise<void> {
  const now = tokens.now ?? new Date();
  const accessTokenEnc = await seal(tokens.accessToken, env);
  const refreshTokenEnc =
    tokens.refreshToken === null
      ? undefined
      : await seal(tokens.refreshToken, env);
  await db
    .update(providerConnections)
    .set({
      accessTokenEnc,
      ...(refreshTokenEnc === undefined ? {} : { refreshTokenEnc }),
      expiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
      ...(tokens.scopes ? { scopes: JSON.stringify([...tokens.scopes]) } : {}),
      status: "active",
      refreshingUntil: null,
      updatedAt: now,
    })
    .where(eq(providerConnections.id, id));
}

/**
 * Take the refresh lease: one conditional UPDATE that wins only when no
 * lease is held or the held one has lapsed. True when this caller won.
 */
async function tryLease(
  id: string,
  now: Date,
  untilMs: number,
): Promise<boolean> {
  const won = await db
    .update(providerConnections)
    .set({ refreshingUntil: new Date(untilMs) })
    .where(
      and(
        eq(providerConnections.id, id),
        or(
          isNull(providerConnections.refreshingUntil),
          lt(providerConnections.refreshingUntil, now),
        ),
      ),
    )
    .returning({ id: providerConnections.id });
  return won.length > 0;
}

/** Give a lease back without new tokens (the refresh failed for a reason worth retrying). */
async function releaseLease(id: string): Promise<void> {
  await db
    .update(providerConnections)
    .set({ refreshingUntil: null })
    .where(eq(providerConnections.id, id));
}

/** The provider refused the refresh: the person has to connect again. */
async function markExpired(id: string, now: Date = new Date()): Promise<void> {
  await db
    .update(providerConnections)
    .set({ status: "expired", refreshingUntil: null, updatedAt: now })
    .where(eq(providerConnections.id, id));
}

async function touchLastUsed(
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(providerConnections)
    .set({ lastUsedAt: now })
    .where(eq(providerConnections.id, id));
}

/** Remove one connection; false when it was already gone. */
async function remove(id: string): Promise<boolean> {
  const removed = await db
    .delete(providerConnections)
    .where(eq(providerConnections.id, id))
    .returning({ id: providerConnections.id });
  return removed.length > 0;
}

/** Remove a member's connections in an organization (they left or were deactivated); the count. */
async function removeForMember(
  organizationId: string,
  userId: string,
): Promise<number> {
  const removed = await db
    .delete(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, organizationId),
        eq(providerConnections.userId, userId),
      ),
    )
    .returning({ id: providerConnections.id });
  return removed.length;
}

/** Remove a member's connections in one app (they lost access to it); the count. */
async function removeForMemberApp(input: {
  organizationId: string;
  userId: string;
  appRowId: string;
}): Promise<number> {
  const removed = await db
    .delete(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, input.organizationId),
        eq(providerConnections.userId, input.userId),
        eq(providerConnections.appRowId, input.appRowId),
      ),
    )
    .returning({ id: providerConnections.id });
  return removed.length;
}

/**
 * Remove the connections in an organization's own apps whose person no
 * longer opens the app (a grant revoked, a group changed or deleted,
 * "Available to everyone" turned off); the count. Shared apps have no
 * grants, so theirs stay.
 */
async function pruneWithoutAccess(organizationId: string): Promise<number> {
  const removed = await db
    .delete(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, organizationId),
        inArray(
          providerConnections.appRowId,
          db
            .select({ id: apps.id })
            .from(apps)
            .where(
              and(
                eq(apps.organizationId, organizationId),
                eq(apps.scope, "org"),
                not(accessToApp(providerConnections.userId, organizationId)),
              ),
            ),
        ),
      ),
    )
    .returning({ id: providerConnections.id });
  return removed.length;
}

/** Remove every connection made in an app (it was deleted); the count. */
async function removeForApp(appRowId: string): Promise<number> {
  const removed = await db
    .delete(providerConnections)
    .where(eq(providerConnections.appRowId, appRowId))
    .returning({ id: providerConnections.id });
  return removed.length;
}

/** Remove every connection to a provider (its row or client was removed); the count. */
async function removeAllForProvider(providerId: string): Promise<number> {
  const removed = await db
    .delete(providerConnections)
    .where(eq(providerConnections.providerId, providerId))
    .returning({ id: providerConnections.id });
  return removed.length;
}

/** How many connections each provider has, for the providers list. */
async function countByProvider(
  organizationId?: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      providerId: providerConnections.providerId,
      count: sql<number>`count(*)`,
    })
    .from(providerConnections)
    .where(
      organizationId
        ? eq(providerConnections.organizationId, organizationId)
        : undefined,
    )
    .groupBy(providerConnections.providerId);
  return Object.fromEntries(
    rows.map((row) => [row.providerId, Number(row.count)]),
  );
}

export const ProviderConnectionRepository = {
  find,
  byId,
  listByOrganization,
  latestActiveForProvider,
  listByUser,
  upsert,
  readTokens,
  storeTokens,
  tryLease,
  releaseLease,
  markExpired,
  touchLastUsed,
  remove,
  removeForMember,
  removeForMemberApp,
  pruneWithoutAccess,
  removeForApp,
  removeAllForProvider,
  countByProvider,
} as const;
