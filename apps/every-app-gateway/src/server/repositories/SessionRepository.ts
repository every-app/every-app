import { db } from "@/db";
import { sessions } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Delete all sessions for a user.
 * Used for security purposes when resetting passwords.
 */
async function deleteByUserId(userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export const SessionRepository = {
  deleteByUserId,
} as const;
