import { db } from "@/db";
import { appTokens, apps, members, users } from "@/db/schema";
import { and, eq, gt, isNull, or, desc } from "drizzle-orm";
import { normalizeTokenScopes } from "../app-token-scopes";
import { isUserBanned } from "../user-ban";
import type { AdminAppToken } from "@/types/app-token";

type ActiveDeployToken = {
  id: string;
  organizationId: string;
  createdBy: string | null;
  scopes: string[];
};

type CreateAppTokenInput = {
  id: string;
  appRowId: string | null;
  organizationId: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  createdBy: string | null;
  expiresAt: Date | null;
};

type AdminAppTokenRecord = Omit<AdminAppToken, "appId"> & {
  appRowId: string | null;
};

/**
 * An unrevoked, unexpired deploy token whose creator is still a member of the
 * token's organization and not deactivated: a deploy token acts for its
 * creator. A token whose creator was deleted (created_by is then null) never
 * works again.
 */
async function findActiveDeployByTokenHash(
  tokenHash: string,
): Promise<ActiveDeployToken | null> {
  const now = new Date();
  const result = await db
    .select({
      id: appTokens.id,
      organizationId: appTokens.organizationId,
      createdBy: appTokens.createdBy,
      scopes: appTokens.scopes,
      creatorBanned: users.banned,
      creatorBanExpires: users.banExpires,
    })
    .from(appTokens)
    .innerJoin(users, eq(appTokens.createdBy, users.id))
    .innerJoin(
      members,
      and(
        eq(members.userId, appTokens.createdBy),
        eq(members.organizationId, appTokens.organizationId),
      ),
    )
    .where(
      and(
        eq(appTokens.tokenHash, tokenHash),
        isNull(appTokens.appRowId),
        isNull(appTokens.revokedAt),
        or(isNull(appTokens.expiresAt), gt(appTokens.expiresAt, now)),
      ),
    )
    .limit(1);

  const token = result[0];
  if (
    !token ||
    isUserBanned({
      banned: token.creatorBanned,
      banExpires: token.creatorBanExpires,
    })
  ) {
    return null;
  }

  return {
    id: token.id,
    organizationId: token.organizationId,
    createdBy: token.createdBy,
    scopes: parseScopes(token.scopes),
  };
}

/**
 * Update last-used timestamp after successful authentication.
 */
async function touchLastUsed(
  id: string,
  organizationId: string,
): Promise<void> {
  await db
    .update(appTokens)
    .set({
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(appTokens.id, id), eq(appTokens.organizationId, organizationId)),
    );
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

async function findById(
  id: string,
  organizationId: string,
): Promise<AdminAppTokenRecord | null> {
  const results = await db
    .select({
      id: appTokens.id,
      appRowId: appTokens.appRowId,
      appSlug: apps.appSlug,
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
    .leftJoin(
      apps,
      and(
        eq(appTokens.appRowId, apps.id),
        eq(appTokens.organizationId, apps.organizationId),
      ),
    )
    .leftJoin(users, eq(appTokens.createdBy, users.id))
    .where(
      and(eq(appTokens.id, id), eq(appTokens.organizationId, organizationId)),
    )
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

async function findAllForAdmin(
  organizationId: string,
): Promise<AdminAppTokenRecord[]> {
  const results = await db
    .select({
      id: appTokens.id,
      appRowId: appTokens.appRowId,
      appSlug: apps.appSlug,
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
    .leftJoin(
      apps,
      and(
        eq(appTokens.appRowId, apps.id),
        eq(appTokens.organizationId, apps.organizationId),
      ),
    )
    .leftJoin(users, eq(appTokens.createdBy, users.id))
    .where(eq(appTokens.organizationId, organizationId))
    .orderBy(desc(appTokens.createdAt));

  return results.map((token) => ({
    ...token,
    scopes: parseScopes(token.scopes),
  }));
}

async function create(data: CreateAppTokenInput): Promise<void> {
  await db.insert(appTokens).values({
    id: data.id,
    appRowId: data.appRowId,
    organizationId: data.organizationId,
    tokenHash: data.tokenHash,
    tokenPrefix: data.tokenPrefix,
    scopes: JSON.stringify(data.scopes),
    createdBy: data.createdBy,
    expiresAt: data.expiresAt,
  });
}

async function revoke(id: string, organizationId: string): Promise<void> {
  await db
    .update(appTokens)
    .set({
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(appTokens.id, id), eq(appTokens.organizationId, organizationId)),
    );
}

export const AppTokenRepository = {
  findActiveDeployByTokenHash,
  touchLastUsed,
  findById,
  findAllForAdmin,
  create,
  revoke,
} as const;
