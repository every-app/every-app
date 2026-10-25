import { db } from "@/db";
import { members, sessions, userAccessTokens, users } from "@/db/schema";
import { and, eq, exists, gte, isNull, not, sql } from "drizzle-orm";
import {
  liveUser,
  wouldLeaveNoLiveOwner,
} from "./OrganizationMembersRepository";

/**
 * Find a user by ID.
 */
async function findById(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
  });
}

/**
 * Delete a user and, by cascade, their sessions, accounts and memberships.
 * (Better Auth's removeUser needs an admin session; server-side cleanup has
 * none.)
 */
async function deleteById(id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}

/**
 * Delete the account with this email if it was created at or after `since`
 * and belongs to no organization: the leftover of an owner claim that died
 * after sign-up but before the organization existed.
 */
async function deleteUnaffiliatedByEmail(
  email: string,
  since: Date,
): Promise<void> {
  const user = await db.query.users.findFirst({
    columns: { id: true },
    where: and(
      eq(users.email, email.trim().toLowerCase()),
      gte(users.createdAt, since),
    ),
  });
  if (!user) return;

  const membership = await db.query.members.findFirst({
    columns: { id: true },
    where: eq(members.userId, user.id),
  });
  if (!membership) await deleteById(user.id);
}

async function markEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Deactivate a user everywhere, in one D1 transaction: ban the account
 * (Better Auth's admin fields, so new sign-ins fail), end every session, and
 * revoke their personal access tokens. With `unlessLastOwnerOf`, the ban
 * refuses, in its own WHERE, an owner of that organization no other live
 * owner would outlast (OrganizationMembersRepository.wouldLeaveNoLiveOwner),
 * and the sessions and tokens go only once the account is deactivated, so
 * a refused ban changes nothing: false then.
 * (The AI apps they connected are revoked after it, by
 * McpConnectionService.revokeForDeactivatedUser.)
 */
async function deactivate(
  userId: string,
  reason: string,
  { unlessLastOwnerOf }: { unlessLastOwnerOf?: string } = {},
): Promise<boolean> {
  const now = new Date();
  const deactivatedNow = exists(
    db
      .select({ one: sql`1` })
      .from(users)
      .where(and(eq(users.id, userId), not(liveUser(now)))),
  );
  const [banned] = await db.batch([
    db
      .update(users)
      .set({
        banned: true,
        banReason: reason,
        banExpires: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(users.id, userId),
          unlessLastOwnerOf
            ? not(wouldLeaveNoLiveOwner(userId, unlessLastOwnerOf, now))
            : undefined,
        ),
      )
      .returning({ id: users.id }),
    db.delete(sessions).where(and(eq(sessions.userId, userId), deactivatedNow)),
    db
      .update(userAccessTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(userAccessTokens.userId, userId),
          isNull(userAccessTokens.revokedAt),
          deactivatedNow,
        ),
      ),
  ]);
  return banned.length > 0;
}

/** Lift a deactivation. Revoked tokens stay revoked. */
async function reactivate(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      banned: false,
      banReason: null,
      banExpires: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

export const UserRepository = {
  findById,
  deleteById,
  deleteUnaffiliatedByEmail,
  markEmailVerified,
  deactivate,
  reactivate,
} as const;
