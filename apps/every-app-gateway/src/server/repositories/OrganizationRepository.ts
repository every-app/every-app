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

export const OrganizationRepository = {
  findSlugById,
} as const;
