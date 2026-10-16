import { db } from "@/db";
import { members, organizations } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";

async function findSlugById(organizationId: string) {
  const rows = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return rows[0]?.slug;
}

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
 * The install's own organization: the one its owner claimed it with. Only
 * the setup claim creates organizations with an owner, so it is the oldest
 * that has one; on a gateway set up before the claim existed, its first
 * owner's. Null before the claim.
 */
async function findInstallOrganizationId(): Promise<string | null> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.role, "owner"),
      ),
    )
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);

  return rows[0]?.id ?? null;
}

/** Delete an organization; memberships, invitations and apps cascade. */
async function deleteById(organizationId: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, organizationId));
}

export const OrganizationRepository = {
  findSlugById,
  findSummaryById,
  findInstallOrganizationId,
  deleteById,
} as const;
