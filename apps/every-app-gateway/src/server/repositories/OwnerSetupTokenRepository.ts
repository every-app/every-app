import { db } from "@/db";
import { ownerSetupTokens } from "@/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";

/** Unconsumed, unexpired claim links. There is normally at most one. */
async function findActiveClaims(now = new Date()) {
  return db
    .select({ id: ownerSetupTokens.id, tokenHash: ownerSetupTokens.tokenHash })
    .from(ownerSetupTokens)
    .where(
      and(
        eq(ownerSetupTokens.kind, "claim"),
        isNull(ownerSetupTokens.consumedAt),
        gt(ownerSetupTokens.expiresAt, now),
      ),
    );
}

/**
 * Mark a link used by `userId`. Guarded on `consumed_at IS NULL`, so of two
 * claims with the same link at most one ever gets `true`.
 */
async function consume(
  id: string,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(ownerSetupTokens)
    .set({ consumedAt: now, consumedBy: userId })
    .where(
      and(eq(ownerSetupTokens.id, id), isNull(ownerSetupTokens.consumedAt)),
    )
    .returning({ id: ownerSetupTokens.id });
  return rows.length === 1;
}

export const OwnerSetupTokenRepository = {
  findActiveClaims,
  consume,
} as const;
