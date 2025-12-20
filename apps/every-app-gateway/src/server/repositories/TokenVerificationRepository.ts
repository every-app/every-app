import { db } from "@/db";
import { verifications } from "@/db/schema";
import { eq } from "drizzle-orm";

// Types for repository operations
type CreateVerification = {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
};

/**
 * Find a verification by token value.
 */
async function findByToken(token: string) {
  return db.query.verifications.findFirst({
    where: eq(verifications.value, token),
  });
}

/**
 * Create a new verification token.
 */
async function create(data: CreateVerification) {
  const now = new Date();

  await db.insert(verifications).values({
    id: data.id,
    identifier: data.identifier,
    value: data.value,
    expiresAt: data.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Delete a verification by ID.
 */
async function deleteById(id: string) {
  await db.delete(verifications).where(eq(verifications.id, id));
}

/**
 * Delete all verifications for a given identifier (email).
 */
async function deleteByIdentifier(identifier: string) {
  await db
    .delete(verifications)
    .where(eq(verifications.identifier, identifier));
}

export const TokenVerificationRepository = {
  findByToken,
  create,
  delete: deleteById,
  deleteByIdentifier,
} as const;
