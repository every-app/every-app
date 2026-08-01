import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import {
  resolvePrimaryOrganizationRole,
  type OrganizationRole,
} from "@/server/org-roles";

export interface OrgContext {
  orgId: string;
  userId: string;
  role: OrganizationRole;
}

const ORG_CONTEXT_CACHE_MAX_ENTRIES = 500;
const ORG_CONTEXT_CACHE_TTL_MS = 30_000;

const orgContextCache = new Map<
  string,
  { context: OrgContext | null; expiresAt: number }
>();

export function clearOrgContextCacheForTests(): void {
  orgContextCache.clear();
}

/**
 * Resolve the verified organization membership a session is acting under.
 * Falls back only when the user belongs to exactly one organization.
 */
export async function resolveOrgContext({
  userId,
  activeOrganizationId,
}: {
  userId: string;
  activeOrganizationId: string | null;
}): Promise<OrgContext | null> {
  const cacheKey = `${userId}\0${activeOrganizationId ?? "sole"}`;
  const now = Date.now();
  const cached = orgContextCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.context;
  }
  if (cached) {
    orgContextCache.delete(cacheKey);
  }

  const context = await resolveOrgContextFromDatabase({
    userId,
    activeOrganizationId,
  });

  // Per-isolate security tradeoff: membership revocation can take up to this
  // 30s TTL to propagate to the perimeter, matching the registry cache.
  orgContextCache.set(cacheKey, {
    context,
    expiresAt: now + ORG_CONTEXT_CACHE_TTL_MS,
  });
  if (orgContextCache.size > ORG_CONTEXT_CACHE_MAX_ENTRIES) {
    const oldest = orgContextCache.keys().next().value;
    if (oldest) orgContextCache.delete(oldest);
  }

  return context;
}

async function resolveOrgContextFromDatabase({
  userId,
  activeOrganizationId,
}: {
  userId: string;
  activeOrganizationId: string | null;
}): Promise<OrgContext | null> {
  if (activeOrganizationId) {
    const row = await db.query.members.findFirst({
      where: and(
        eq(members.userId, userId),
        eq(members.organizationId, activeOrganizationId),
      ),
    });
    return row ? toOrgContext(row, userId) : null;
  }

  const rows = await db.query.members.findMany({
    where: eq(members.userId, userId),
    limit: 2,
  });
  return rows.length === 1 ? toOrgContext(rows[0], userId) : null;
}

function toOrgContext(
  row: {
    organizationId: string;
    role: string | readonly string[] | null | undefined;
  },
  userId: string,
): OrgContext | null {
  const role = resolvePrimaryOrganizationRole(row.role);
  return role ? { orgId: row.organizationId, userId, role } : null;
}
