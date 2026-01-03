import { db } from "@/db";
import { chats } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { Chat } from "@/types";

/**
 * Find all chats for a user, ordered by most recently updated.
 */
async function findAllByUserId(userId: string) {
  return db
    .select()
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(desc(chats.updatedAt));
}

/**
 * Find a chat by ID and verify ownership.
 */
async function findByIdAndUserId(id: string, userId: string) {
  const result = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

/**
 * Verify chat ownership.
 */
async function verifyChatOwnership(
  chatId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return result.length > 0;
}

/**
 * Create a new chat.
 */
async function create(chat: Chat) {
  await db.insert(chats).values(chat);
  return chat;
}

/**
 * Update a chat.
 */
async function update(
  id: string,
  userId: string,
  data: { title?: string; updatedAt?: string },
) {
  const result = await db
    .update(chats)
    .set(data)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .returning();
  return result.length > 0 ? result[0] : null;
}

/**
 * Update chat's updatedAt timestamp.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function touch(id: string, userId: string) {
  await db
    .update(chats)
    .set({ updatedAt: new Date().toISOString() })
    .where(and(eq(chats.id, id), eq(chats.userId, userId)));
}

/**
 * Delete a chat.
 */
async function deleteById(id: string, userId: string) {
  const result = await db
    .delete(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .returning();
  return result.length > 0;
}

export const ChatRepository = {
  findAllByUserId,
  findByIdAndUserId,
  verifyChatOwnership,
  create,
  update,
  touch,
  delete: deleteById,
} as const;
