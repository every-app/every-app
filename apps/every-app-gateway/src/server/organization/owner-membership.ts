import { db } from "@/db";
import { members, ownerBootstrap } from "@/db/schema";
import { and, eq } from "drizzle-orm";

const OWNER_BOOTSTRAP_ID = "owner";
// A claim that holds the bootstrap row longer than this without producing an
// owner died part-way: a Worker killed for CPU time never runs its cleanup.
const STALE_BOOTSTRAP_MS = 120_000;

export async function hasAnyOwnerMembership(): Promise<boolean> {
  // Deliberately global across the whole Gateway install.
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

/**
 * Delete a bootstrap row left behind by a claim that died part-way, so the
 * next claim can proceed. Only call this while no owner exists. Returns when
 * the stale claim started (anything it created is newer), or null if there
 * was nothing stale to clear.
 */
export async function clearStaleOwnerBootstrap(
  now = Date.now(),
): Promise<Date | null> {
  const bootstrap = await db.query.ownerBootstrap.findFirst({
    where: eq(ownerBootstrap.id, OWNER_BOOTSTRAP_ID),
  });
  if (!bootstrap || bootstrap.claimedAt.getTime() > now - STALE_BOOTSTRAP_MS) {
    return null;
  }

  await db
    .delete(ownerBootstrap)
    .where(
      and(
        eq(ownerBootstrap.id, OWNER_BOOTSTRAP_ID),
        eq(ownerBootstrap.claimedAt, bootstrap.claimedAt),
      ),
    );
  return bootstrap.claimedAt;
}
