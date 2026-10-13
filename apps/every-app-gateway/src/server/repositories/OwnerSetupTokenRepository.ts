import { db } from "@/db";
import { ownerSetupTokens } from "@/db/schema";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";

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

/**
 * Claim links with a CLI secret whose deploy token hasn't been handed out:
 * the ones a CLI may still log itself in with. There is normally at most one.
 */
async function findClaimsAwaitingDeployToken() {
  return db
    .select({
      id: ownerSetupTokens.id,
      cliSecretHash: ownerSetupTokens.cliSecretHash,
      expiresAt: ownerSetupTokens.expiresAt,
      consumedAt: ownerSetupTokens.consumedAt,
      consumedBy: ownerSetupTokens.consumedBy,
    })
    .from(ownerSetupTokens)
    .where(
      and(
        eq(ownerSetupTokens.kind, "claim"),
        isNotNull(ownerSetupTokens.cliSecretHash),
        isNull(ownerSetupTokens.deployTokenIssuedAt),
      ),
    );
}

/**
 * Note that a link's deploy token is being handed out. Guarded on
 * `deploy_token_issued_at IS NULL`, so of two retrievals at most one gets
 * `true`.
 */
async function markDeployTokenIssued(
  id: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(ownerSetupTokens)
    .set({ deployTokenIssuedAt: now })
    .where(
      and(
        eq(ownerSetupTokens.id, id),
        isNull(ownerSetupTokens.deployTokenIssuedAt),
      ),
    )
    .returning({ id: ownerSetupTokens.id });
  return rows.length === 1;
}

/** Undo `markDeployTokenIssued` when the token couldn't be issued after all. */
async function unmarkDeployTokenIssued(id: string): Promise<void> {
  await db
    .update(ownerSetupTokens)
    .set({ deployTokenIssuedAt: null })
    .where(eq(ownerSetupTokens.id, id));
}

export const OwnerSetupTokenRepository = {
  findActiveClaims,
  consume,
  findClaimsAwaitingDeployToken,
  markDeployTokenIssued,
  unmarkDeployTokenIssued,
} as const;
