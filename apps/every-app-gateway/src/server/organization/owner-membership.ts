import { db } from "@/db";
import { members, ownerBootstrap } from "@/db/schema";
import { eq } from "drizzle-orm";

const OWNER_BOOTSTRAP_ID = "owner";

export async function hasAnyOwnerMembership(): Promise<boolean> {
  // Deliberately global across the gateway deployment.
  // Bootstrap is a one-time system initialization, not per-organization.
  const ownerMembership = await db.query.members.findFirst({
    columns: { id: true },
    where: eq(members.role, "owner"),
  });

  return Boolean(ownerMembership);
}

export async function claimOwnerBootstrap(): Promise<boolean> {
  const claimedRows = await db
    .insert(ownerBootstrap)
    .values({ id: OWNER_BOOTSTRAP_ID })
    .onConflictDoNothing({ target: ownerBootstrap.id })
    .returning({ id: ownerBootstrap.id });

  return claimedRows.length === 1;
}

export async function releaseOwnerBootstrap(): Promise<void> {
  await db
    .delete(ownerBootstrap)
    .where(eq(ownerBootstrap.id, OWNER_BOOTSTRAP_ID));
}
