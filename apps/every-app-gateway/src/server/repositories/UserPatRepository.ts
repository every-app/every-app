import { db } from "@/db";
import { apps, userAccessTokens, users } from "@/db/schema";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { UserAccessToken } from "@/types/user-token";

type ActiveUserPat = {
  id: string;
  userId: string;
  userEmail: string;
  organizationId: string;
  appRowId: string | null;
  scopes: string[];
};

type CreateUserPatInput = {
  id: string;
  userId: string;
  organizationId: string;
  appRowId: string | null;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date;
};

type UserPatRecord = Omit<UserAccessToken, "appId"> & {
  appRowId: string | null;
};

function parseScopes(rawScopes: string): string[] {
  try {
    const parsed = JSON.parse(rawScopes) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(parsed.filter((s): s is string => typeof s === "string")),
    ];
  } catch {
    return [];
  }
}

async function findActiveByTokenHash(
  tokenHash: string,
): Promise<ActiveUserPat | null> {
  const now = new Date();
  const result = await db
    .select({
      id: userAccessTokens.id,
      userId: userAccessTokens.userId,
      userEmail: users.email,
      organizationId: userAccessTokens.organizationId,
      appRowId: userAccessTokens.appRowId,
      scopes: userAccessTokens.scopes,
    })
    .from(userAccessTokens)
    .innerJoin(users, eq(userAccessTokens.userId, users.id))
    .where(
      and(
        eq(userAccessTokens.tokenHash, tokenHash),
        isNull(userAccessTokens.revokedAt),
        gt(userAccessTokens.expiresAt, now),
      ),
    )
    .limit(1);

  const token = result[0];
  if (!token) return null;

  return {
    ...token,
    scopes: parseScopes(token.scopes),
  };
}

async function touchLastUsed(id: string, userId: string): Promise<void> {
  await db
    .update(userAccessTokens)
    .set({
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(userAccessTokens.id, id), eq(userAccessTokens.userId, userId)),
    );
}

async function findByIdForUser(
  id: string,
  userId: string,
): Promise<UserPatRecord | null> {
  const result = await db
    .select({
      id: userAccessTokens.id,
      userId: userAccessTokens.userId,
      userEmail: users.email,
      organizationId: userAccessTokens.organizationId,
      appRowId: userAccessTokens.appRowId,
      appSlug: apps.appSlug,
      appName: apps.name,
      name: userAccessTokens.name,
      tokenPrefix: userAccessTokens.tokenPrefix,
      scopes: userAccessTokens.scopes,
      createdAt: userAccessTokens.createdAt,
      updatedAt: userAccessTokens.updatedAt,
      expiresAt: userAccessTokens.expiresAt,
      revokedAt: userAccessTokens.revokedAt,
      lastUsedAt: userAccessTokens.lastUsedAt,
    })
    .from(userAccessTokens)
    .innerJoin(users, eq(userAccessTokens.userId, users.id))
    .leftJoin(
      apps,
      and(
        eq(userAccessTokens.appRowId, apps.id),
        eq(userAccessTokens.organizationId, apps.organizationId),
      ),
    )
    .where(
      and(eq(userAccessTokens.id, id), eq(userAccessTokens.userId, userId)),
    )
    .limit(1);

  const token = result[0];
  if (!token) return null;

  return {
    ...token,
    scopes: parseScopes(token.scopes),
  };
}

async function create(data: CreateUserPatInput): Promise<void> {
  await db.insert(userAccessTokens).values({
    id: data.id,
    userId: data.userId,
    organizationId: data.organizationId,
    appRowId: data.appRowId,
    name: data.name,
    tokenHash: data.tokenHash,
    tokenPrefix: data.tokenPrefix,
    scopes: JSON.stringify(data.scopes),
    expiresAt: data.expiresAt,
  });
}

async function revoke(id: string, userId: string): Promise<void> {
  await db
    .update(userAccessTokens)
    .set({
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(userAccessTokens.id, id), eq(userAccessTokens.userId, userId)),
    );
}

async function listForUser(
  userId: string,
  organizationId: string,
): Promise<UserPatRecord[]> {
  const results = await db
    .select({
      id: userAccessTokens.id,
      userId: userAccessTokens.userId,
      userEmail: users.email,
      organizationId: userAccessTokens.organizationId,
      appRowId: userAccessTokens.appRowId,
      appSlug: apps.appSlug,
      appName: apps.name,
      name: userAccessTokens.name,
      tokenPrefix: userAccessTokens.tokenPrefix,
      scopes: userAccessTokens.scopes,
      createdAt: userAccessTokens.createdAt,
      updatedAt: userAccessTokens.updatedAt,
      expiresAt: userAccessTokens.expiresAt,
      revokedAt: userAccessTokens.revokedAt,
      lastUsedAt: userAccessTokens.lastUsedAt,
    })
    .from(userAccessTokens)
    .innerJoin(users, eq(userAccessTokens.userId, users.id))
    .leftJoin(
      apps,
      and(
        eq(userAccessTokens.appRowId, apps.id),
        eq(userAccessTokens.organizationId, apps.organizationId),
      ),
    )
    .where(
      and(
        eq(userAccessTokens.userId, userId),
        eq(userAccessTokens.organizationId, organizationId),
      ),
    )
    .orderBy(desc(userAccessTokens.createdAt));

  return results.map((token) => ({
    ...token,
    scopes: parseScopes(token.scopes),
  }));
}

export const UserPatRepository = {
  findActiveByTokenHash,
  touchLastUsed,
  findByIdForUser,
  create,
  revoke,
  listForUser,
} as const;
