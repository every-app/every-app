import { db } from "@/db";
import { accounts } from "@/db/schema";
import { and, eq } from "drizzle-orm";

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
