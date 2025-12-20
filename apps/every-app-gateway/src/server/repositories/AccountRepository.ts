import { db } from "@/db";
import { accounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * Update the password for a user's credential account.
 * Better Auth stores credential passwords in the accounts table with providerId = "credential".
 */
async function updatePassword(userId: string, hashedPassword: string) {
  await db
    .update(accounts)
    .set({
      password: hashedPassword,
    })
    .where(
      and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")),
    );
}

export const AccountRepository = {
  updatePassword,
} as const;
