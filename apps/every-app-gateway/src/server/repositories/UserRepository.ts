import { db } from "@/db";
import {
  appTokens,
  members,
  sessions,
  userAccessTokens,
  users,
} from "@/db/schema";
import { and, eq, gte, isNull } from "drizzle-orm";

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

/**
 * Deactivate a user everywhere, in one D1 transaction: ban the account
 * (Better Auth's admin fields, so new sign-ins fail), end every session, and
 * revoke their personal access tokens and the deploy tokens they created.
 */
async function deactivate(userId: string, reason: string): Promise<void> {
  const now = new Date();
  await db.batch([
    db
      .update(users)
      .set({
        banned: true,
        banReason: reason,
        banExpires: null,
        updatedAt: now,
      })
      .where(eq(users.id, userId)),
    db.delete(sessions).where(eq(sessions.userId, userId)),
    db
      .update(userAccessTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(userAccessTokens.userId, userId),
          isNull(userAccessTokens.revokedAt),
        ),
      ),
    db
      .update(appTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(appTokens.createdBy, userId), isNull(appTokens.revokedAt))),
  ]);
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
  deactivate,
  reactivate,
} as const;
