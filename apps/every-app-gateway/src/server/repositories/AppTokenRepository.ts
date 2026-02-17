import { db } from "@/db";
import { appTokens, apps, users } from "@/db/schema";
import { and, eq, gt, isNull, or, desc } from "drizzle-orm";
import { normalizeTokenScopes } from "../app-token-scopes";
import type { AdminAppToken } from "@/types/app-token";

type ActiveAppToken = {
  id: string;
  appId: string;
  scopes: string[];
};

type CreateAppTokenInput = {
  id: string;
  appId: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  createdBy: string | null;
  expiresAt: Date | null;
};

/**
 * Find an active app token by its hashed value.
 * A token is active when it is not revoked and not expired.
 */
async function findActiveByTokenHash(
  tokenHash: string,
): Promise<ActiveAppToken | null> {
  const now = new Date();
  const result = await db
    .select({
      id: appTokens.id,
      appId: apps.appId,
      scopes: appTokens.scopes,
    })
    .from(appTokens)
    .innerJoin(apps, eq(appTokens.appId, apps.id))
    .where(
      and(
        eq(appTokens.tokenHash, tokenHash),
        isNull(appTokens.revokedAt),
        or(isNull(appTokens.expiresAt), gt(appTokens.expiresAt, now)),
      ),
    )
    .limit(1);

  const token = result[0];
  if (!token) {
    return null;
  }

  return {
    id: token.id,
    appId: token.appId,
    scopes: parseScopes(token.scopes),
  };
}

/**
 * Update last-used timestamp after successful authentication.
 */
async function touchLastUsed(id: string): Promise<void> {
  await db
    .update(appTokens)
    .set({
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(appTokens.id, id));
}

function parseScopes(rawScopes: string): string[] {
  try {
    const parsed = JSON.parse(rawScopes) as unknown;
    if (!Array.isArray(parsed)) return [];
    const stringScopes = parsed.filter(
      (scope): scope is string => typeof scope === "string",
    );
    return normalizeTokenScopes(stringScopes);
  } catch {
    return [];
  }
}

async function findById(id: string): Promise<AdminAppToken | null> {
  const results = await db
    .select({
      id: appTokens.id,
      appId: appTokens.appId,
      appSlug: apps.appId,
      appName: apps.name,
      tokenPrefix: appTokens.tokenPrefix,
      scopes: appTokens.scopes,
      createdAt: appTokens.createdAt,
      updatedAt: appTokens.updatedAt,
      createdById: appTokens.createdBy,
      createdByEmail: users.email,
      expiresAt: appTokens.expiresAt,
      revokedAt: appTokens.revokedAt,
      lastUsedAt: appTokens.lastUsedAt,
    })
    .from(appTokens)
    .innerJoin(apps, eq(appTokens.appId, apps.id))
    .leftJoin(users, eq(appTokens.createdBy, users.id))
    .where(eq(appTokens.id, id))
    .limit(1);

  const token = results[0];
  if (!token) {
    return null;
  }

  return {
    ...token,
    scopes: parseScopes(token.scopes),
  };
}

async function findAllForAdmin(): Promise<AdminAppToken[]> {
  const results = await db
    .select({
      id: appTokens.id,
      appId: appTokens.appId,
      appSlug: apps.appId,
      appName: apps.name,
      tokenPrefix: appTokens.tokenPrefix,
      scopes: appTokens.scopes,
      createdAt: appTokens.createdAt,
      updatedAt: appTokens.updatedAt,
      createdById: appTokens.createdBy,
      createdByEmail: users.email,
      expiresAt: appTokens.expiresAt,
      revokedAt: appTokens.revokedAt,
      lastUsedAt: appTokens.lastUsedAt,
    })
    .from(appTokens)
    .innerJoin(apps, eq(appTokens.appId, apps.id))
    .leftJoin(users, eq(appTokens.createdBy, users.id))
    .orderBy(desc(appTokens.createdAt));

  return results.map((token) => ({
    ...token,
    scopes: parseScopes(token.scopes),
  }));
}

async function create(data: CreateAppTokenInput): Promise<void> {
  await db.insert(appTokens).values({
    id: data.id,
    appId: data.appId,
    tokenHash: data.tokenHash,
    tokenPrefix: data.tokenPrefix,
    scopes: JSON.stringify(data.scopes),
    createdBy: data.createdBy,
    expiresAt: data.expiresAt,
  });
}

async function revoke(id: string): Promise<void> {
  await db
    .update(appTokens)
    .set({
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(appTokens.id, id));
}

/**
 * Check whether an app already has at least one active (non-revoked, non-expired) token.
 */
async function hasActiveTokenForApp(appId: string): Promise<boolean> {
  const now = new Date();
  const result = await db
    .select({ id: appTokens.id })
    .from(appTokens)
    .where(
      and(
        eq(appTokens.appId, appId),
        isNull(appTokens.revokedAt),
        or(isNull(appTokens.expiresAt), gt(appTokens.expiresAt, now)),
      ),
    )
    .limit(1);

  return result.length > 0;
}

export const AppTokenRepository = {
  findActiveByTokenHash,
  touchLastUsed,
  findById,
  findAllForAdmin,
  create,
  revoke,
  hasActiveTokenForApp,
} as const;
