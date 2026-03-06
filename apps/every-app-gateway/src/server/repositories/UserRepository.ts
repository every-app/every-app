import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Find a user by ID.
 */
async function findById(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
  });
}

export const UserRepository = {
  findById,
} as const;
