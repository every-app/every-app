import { db } from "@/db";
import { organizationKeys } from "@/db/schema";
import { eq } from "drizzle-orm";

async function findByOrganizationId(
  organizationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ orgKey: organizationKeys.orgKey })
    .from(organizationKeys)
    .where(eq(organizationKeys.organizationId, organizationId))
    .limit(1);
  return rows[0]?.orgKey ?? null;
}

/**
 * Give an organization `orgKey` unless it already has one. Returns the key
 * the organization holds afterwards: `orgKey`, an earlier (or concurrent)
 * one, or null when another organization holds `orgKey`.
 */
async function claim(
  organizationId: string,
  orgKey: string,
): Promise<string | null> {
  await db
    .insert(organizationKeys)
    .values({ organizationId, orgKey })
    .onConflictDoNothing();
  return findByOrganizationId(organizationId);
}

export const OrganizationKeyRepository = {
  findByOrganizationId,
  claim,
} as const;
