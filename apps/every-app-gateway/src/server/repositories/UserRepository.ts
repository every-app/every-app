import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { UserRole, UserStatus } from "@/auth/shared";

// Types for repository operations
type UserListItem = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  status: string | null;
  createdAt: Date;
  banned: boolean | null;
};

type UpdateUserData = {
  role?: UserRole;
  status?: UserStatus;
};

/**
 * Find a user by ID.
 */
async function findById(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
  });
}

/**
 * Find a user by email.
 */
async function findByEmail(email: string) {
  return db.query.users.findFirst({
    where: eq(users.email, email),
  });
}

/**
 * Find the first user with owner role.
 */
async function findOwner() {
  return db.query.users.findFirst({
    where: eq(users.role, "owner" satisfies UserRole),
  });
}

/**
 * Find all users with selected columns for listing.
 */
async function findAllForList(): Promise<UserListItem[]> {
  return db.query.users.findMany({
    columns: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
      banned: true,
    },
    orderBy: (users, { desc }) => [desc(users.createdAt)],
  });
}

/**
 * Update a user by ID.
 */
async function update(id: string, data: UpdateUserData) {
  await db.update(users).set(data).where(eq(users.id, id));
}

/**
 * Delete a user by ID.
 */
async function deleteById(id: string) {
  await db.delete(users).where(eq(users.id, id));
}

export const UserRepository = {
  findById,
  findByEmail,
  findOwner,
  findAllForList,
  update,
  delete: deleteById,
} as const;
