import { db } from "@/db";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";

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

/** Delete an organization; memberships, invitations and apps cascade. */
async function deleteById(organizationId: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, organizationId));
}

export const OrganizationRepository = {
  findSlugById,
  findSummaryById,
  deleteById,
} as const;
