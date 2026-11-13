import { and, asc, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { providerAppAccess, providerConnections } from "@/db/schema";
import { open, seal, type SealingEnv } from "@/server/secrets/sealed";
import { ProviderAppAccessRepository } from "./ProviderAppAccessRepository";
import { storedStrings } from "./stored-strings";

/**
 * One person's connection to one OAuth provider
 * (docs/design/2026-11-oauth-one-connection.md). Tokens are sealed on the
 * way in (`upsert`) and opened on the way out (`readTokens`); the listing
 * shapes never carry them. One row per (organization, provider, user);
 * the apps that may use it are ProviderAppAccessRepository's. The
 * lifecycle deletes: a disconnect (`remove`), a member leaving or
 * deactivated (`removeForMember`), the provider removed
 * (`removeAllForProvider`). Each takes the access apps had with it.
 */
type ConnectionStatus = "active" | "expired";

/** What names one connection: the person's, to one provider, in one organization. */
export interface ConnectionKey {
  organizationId: string;
  providerId: string;
  userId: string;
}

/** A connection as Settings, Admin and the CLI list it: no token. */
export interface ProviderConnection {
  id: string;
  organizationId: string;
  providerId: string;
  userId: string;
  label: string | null;
  externalId: string | null;
  /** The scopes the token holds, canonical. */
  scopes: string[];
  /**
   * The scopes the provider was asked for at the last connect, canonical;
   * null when that isn't known (connected before it was kept).
   */
  askedScopes: string[] | null;
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
  /** Which write of the tokens this is: what a later write is checked against. */
  version: number;
  status: ConnectionStatus;
}

/** How long one refresh may hold the lease. */
const REFRESH_LEASE_MS = 30_000;

const listed = {
  id: providerConnections.id,
  organizationId: providerConnections.organizationId,
  providerId: providerConnections.providerId,
  userId: providerConnections.userId,
  label: providerConnections.label,
  externalId: providerConnections.externalId,
  scopes: providerConnections.scopes,
  askedScopes: providerConnections.askedScopes,
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
  label: string | null;
  externalId: string | null;
  scopes: string;
  askedScopes: string | null;
  expiresAt: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

function shape(row: ListedRow): ProviderConnection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerId: row.providerId,
    userId: row.userId,
    label: row.label,
    externalId: row.externalId,
    scopes: storedStrings(row.scopes),
    askedScopes:
      row.askedScopes === null ? null : storedStrings(row.askedScopes),
    expiresAt: row.expiresAt?.getTime() ?? null,
    status: row.status === "expired" ? "expired" : "active",
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
  };
}

/** The person's connection to the provider, or null. */
async function find(input: ConnectionKey): Promise<ProviderConnection | null> {
  const [row] = await db
    .select(listed)
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, input.organizationId),
        eq(providerConnections.providerId, input.providerId),
        eq(providerConnections.userId, input.userId),
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
 * The active connection to a provider that was used most recently (then
 * the most recently updated), of any member who allowed the app: what
 * lists a remote MCP server's tools when no one in particular is calling.
 * Null when there is none.
 */
async function latestActiveForApp(
  organizationId: string,
  providerId: string,
  appRowId: string,
): Promise<ProviderConnection | null> {
  const [row] = await db
    .select(listed)
    .from(providerConnections)
    .innerJoin(
      providerAppAccess,
      and(
        eq(
          providerAppAccess.organizationId,
          providerConnections.organizationId,
        ),
        eq(providerAppAccess.providerId, providerConnections.providerId),
        eq(providerAppAccess.userId, providerConnections.userId),
        eq(providerAppAccess.appRowId, appRowId),
      ),
    )
    .where(
      and(
        eq(providerConnections.organizationId, organizationId),
        eq(providerConnections.providerId, providerId),
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
 * (a reconnect replaces tokens, scopes and label; the id and `createdAt`
 * stay). Tokens are sealed here.
 */
async function upsert(
  input: {
    organizationId: string;
    providerId: string;
    userId: string;
    /** apps.id of the app the connect started in (the column the CLI before 0034 reads). */
    appRowId: string;
    label: string | null;
    externalId: string | null;
    /** The scopes the token holds, canonical. */
    scopes: readonly string[];
    /** The scopes the provider was asked for, canonical; left out when not known. */
    askedScopes?: readonly string[];
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
    appRowId: input.appRowId,
    label: input.label,
    externalId: input.externalId,
    scopes: JSON.stringify([...input.scopes]),
    askedScopes: input.askedScopes
      ? JSON.stringify([...input.askedScopes])
      : null,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
    status: "active" as const,
    refreshingUntil: null,
    updatedAt: now,
  };
  const bumped = sql`${providerConnections.tokenVersion} + 1`;
  const [row] = await db
    .insert(providerConnections)
    .values({
      id: `conn_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      providerId: input.providerId,
      userId: input.userId,
      createdAt: now,
      lastUsedAt: null,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        providerConnections.organizationId,
        providerConnections.providerId,
        providerConnections.userId,
      ],
      // A refresh still out with the old tokens stores nothing over these.
      set: { ...values, tokenVersion: bumped },
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
      version: providerConnections.tokenVersion,
      status: providerConnections.status,
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
    version: row.version,
    status: row.status === "expired" ? "expired" : "active",
  };
}

/** The row, while its tokens are still write `version` (any write, when undefined). */
function atVersion(id: string, version: number | undefined) {
  return version === undefined
    ? eq(providerConnections.id, id)
    : and(
        eq(providerConnections.id, id),
        eq(providerConnections.tokenVersion, version),
      );
}

/**
 * Store the tokens a refresh returned: the row is active again, its lease
 * released, its version one higher. A refresh that returned no new refresh
 * token keeps the old one (pass null). With `version`, only while the
 * tokens are still the ones the refresh read; false when they were
 * replaced meanwhile, and nothing is written.
 */
async function storeTokens(
  id: string,
  tokens: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    scopes?: readonly string[];
    now?: Date;
    version?: number;
  },
  env: SealingEnv,
): Promise<boolean> {
  const now = tokens.now ?? new Date();
  const accessTokenEnc = await seal(tokens.accessToken, env);
  const refreshTokenEnc =
    tokens.refreshToken === null
      ? undefined
      : await seal(tokens.refreshToken, env);
  const stored = await db
    .update(providerConnections)
    .set({
      accessTokenEnc,
      ...(refreshTokenEnc === undefined ? {} : { refreshTokenEnc }),
      expiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
      ...(tokens.scopes ? { scopes: JSON.stringify([...tokens.scopes]) } : {}),
      status: "active",
      refreshingUntil: null,
      tokenVersion: sql`${providerConnections.tokenVersion} + 1`,
      updatedAt: now,
    })
    .where(atVersion(id, tokens.version))
    .returning({ id: providerConnections.id });
  return stored.length > 0;
}

/**
 * Take the refresh lease for tokens at `version`: one conditional UPDATE
 * that wins only while those are still the stored tokens and no lease is
 * held (or the held one has lapsed). True when this caller won; it then
 * holds the lease for {@link REFRESH_LEASE_MS}.
 */
async function claimRefresh(
  id: string,
  version: number,
  now: Date,
): Promise<boolean> {
  const won = await db
    .update(providerConnections)
    .set({ refreshingUntil: new Date(now.getTime() + REFRESH_LEASE_MS) })
    .where(
      and(
        atVersion(id, version),
        or(
          isNull(providerConnections.refreshingUntil),
          lt(providerConnections.refreshingUntil, now),
        ),
      ),
    )
    .returning({ id: providerConnections.id });
  return won.length > 0;
}

/** Give the lease back without new tokens (the refresh failed for a reason worth retrying). */
async function releaseRefresh(id: string, version: number): Promise<void> {
  await db
    .update(providerConnections)
    .set({ refreshingUntil: null })
    .where(atVersion(id, version));
}

/**
 * The person has to connect again. With `version`, only while the tokens
 * are still the ones that were refused. True when this call is the one
 * that changed the row from active to expired (the caller says so once).
 */
async function markExpired(
  id: string,
  now: Date = new Date(),
  version?: number,
): Promise<boolean> {
  const changed = await db
    .update(providerConnections)
    .set({ status: "expired", refreshingUntil: null, updatedAt: now })
    .where(
      and(atVersion(id, version), ne(providerConnections.status, "expired")),
    )
    .returning({ id: providerConnections.id });
  return changed.length > 0;
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

/**
 * Remove one connection, and the access apps had to it; false when it
 * was already gone. The access goes first: were the second delete to
 * fail, the apps would ask again, never use a connection they weren't
 * allowed.
 */
async function remove(
  connection: ConnectionKey & { id: string },
): Promise<boolean> {
  await ProviderAppAccessRepository.removeForConnection(connection);
  const removed = await db
    .delete(providerConnections)
    .where(eq(providerConnections.id, connection.id))
    .returning({ id: providerConnections.id });
  return removed.length > 0;
}

/**
 * Remove a member's connections in an organization (they left or were
 * deactivated), and the access apps had to them; the count.
 */
async function removeForMember(
  organizationId: string,
  userId: string,
): Promise<number> {
  await db
    .delete(providerAppAccess)
    .where(
      and(
        eq(providerAppAccess.organizationId, organizationId),
        eq(providerAppAccess.userId, userId),
      ),
    );
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

/**
 * Remove every connection to a provider (its row or client was removed),
 * and the access apps had to them; the count.
 */
async function removeAllForProvider(providerId: string): Promise<number> {
  await db
    .delete(providerAppAccess)
    .where(eq(providerAppAccess.providerId, providerId));
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
  latestActiveForApp,
  listByUser,
  upsert,
  readTokens,
  storeTokens,
  claimRefresh,
  releaseRefresh,
  markExpired,
  touchLastUsed,
  remove,
  removeForMember,
  removeAllForProvider,
  countByProvider,
} as const;
