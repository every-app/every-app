import { db } from "@/db";
import { sessions } from "@/db/schema";
import { eq } from "drizzle-orm";

async function deleteByUserId(userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export const SessionRepository = {
  deleteByUserId,
} as const;
