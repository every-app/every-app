import { db } from "@/db";
import { apps, members, organizations, users } from "@/db/schema";
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import { liveUser } from "@/server/repositories/OrganizationMembersRepository";
import { and, asc, eq, exists, ne, notExists } from "drizzle-orm";

/** An organization's display fields (no members, no invitations). */
async function findSummaryById(organizationId: string) {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The organization apps were deployed to before the gateway had an owner:
 * the oldest one with live apps and no members. The setup claim makes its
 * first owner the owner of this one instead of creating another. Null when
 * there is none.
 */
async function findAwaitingOwner(): Promise<string | null> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        notExists(
          db
            .select({ id: members.id })
            .from(members)
            .where(eq(members.organizationId, organizations.id)),
        ),
        exists(
          db
            .select({ id: apps.id })
            .from(apps)
            .where(
              and(
                eq(apps.organizationId, organizations.id),
                ne(apps.status, DELETED_APP_STATUS),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Make `userId` the owner of an organization that has none, and give it the
 * name the claim would have given a new one.
 */
async function adoptForOwner(
  organizationId: string,
  { userId, name }: { userId: string; name: string },
): Promise<void> {
  await db.batch([
    db
      .update(organizations)
      .set({ name })
      .where(eq(organizations.id, organizationId)),
    db.insert(members).values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    }),
  ]);
}

/**
 * Whether work no person started may be attributed to the organization (a
 * shared app's `x-everyapp-org`): it exists, is active, and has at least
 * one member who isn't deactivated (banned with no expiry, or one still to
 * come, as isUserBanned reads it).
 */
async function isAttributable(
  organizationId: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.status, "active"),
        exists(
          db
            .select({ id: members.id })
            .from(members)
            .innerJoin(users, eq(users.id, members.userId))
            .where(
              and(eq(members.organizationId, organizations.id), liveUser(now)),
            ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Delete an organization; memberships, invitations and apps cascade. */
async function deleteById(organizationId: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, organizationId));
}

export const OrganizationRepository = {
  findSummaryById,
  findAwaitingOwner,
  adoptForOwner,
  isAttributable,
  deleteById,
} as const;
