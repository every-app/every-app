import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { members, organizations, sessions } from "@/db/schema";
import {
  resolvePrimaryOrganizationRole,
  type OrganizationRole,
} from "@/server/org-roles";
import { isPersonalOrganizationOf } from "./personal-marker";

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
 * Drop this isolate's cached memberships for a user after changing their
 * role or deactivating them (other isolates catch up within the TTL).
 */
export function forgetOrgContext(userId: string): void {
  for (const key of orgContextCache.keys()) {
    if (key.startsWith(`${userId}\0`)) orgContextCache.delete(key);
  }
}

/**
 * Resolve the verified organization membership a session is acting under.
 * Every session starts with an organization when the user has one
 * (chooseSessionOrganization); a session without one (made before the user
 * joined any) falls back only when the user belongs to exactly one, and
 * never guesses between several.
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

/** How many of the user's latest sessions "last active" looks through. */
const RECENT_SESSIONS = 5;

/**
 * The organization a new session starts in: the user's personal
 * organization, else the one their latest session was in (if they are still
 * a member there), else the first they joined. Null with no membership of a
 * role the gateway knows. Read fresh, never from the cache: it runs once per
 * sign-in.
 */
export async function chooseSessionOrganization(
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      organizationId: members.organizationId,
      role: members.role,
      metadata: organizations.metadata,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt), asc(members.id));
  const memberships = rows.filter((row) =>
    resolvePrimaryOrganizationRole(row.role),
  );
  if (memberships.length === 0) return null;

  const personal = memberships.find((row) =>
    isPersonalOrganizationOf(row.metadata, userId),
  );
  if (personal) return personal.organizationId;

  if (memberships.length > 1) {
    const recent = await db
      .select({ organizationId: sessions.activeOrganizationId })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNotNull(sessions.activeOrganizationId),
        ),
      )
      .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt))
      .limit(RECENT_SESSIONS);
    const member = new Set(memberships.map((row) => row.organizationId));
    const lastActive = recent.find(
      (row) => row.organizationId && member.has(row.organizationId),
    );
    if (lastActive?.organizationId) return lastActive.organizationId;
  }

  return memberships[0]!.organizationId;
}
