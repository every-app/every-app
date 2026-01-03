import { ChatRepository } from "../repositories/ChatRepository";
import type { Chat } from "@/types";

/**
 * Get all chats for a user.
 */
async function getAll(userId: string) {
  return ChatRepository.findAllByUserId(userId);
}

/**
 * Create a new chat.
 * @param id - Optional ID. If not provided, a new UUID will be generated.
 */
async function create(
  userId: string,
  title: string,
  id?: string,
): Promise<Chat> {
  const now = new Date().toISOString();
  const chat: Chat = {
    id: id ?? crypto.randomUUID(),
    userId,
    title,
    createdAt: now,
    updatedAt: now,
  };
  await ChatRepository.create(chat);
  return chat;
}

/**
 * Update a chat's title.
 */
async function update(
  userId: string,
  id: string,
  title: string,
): Promise<Chat | null> {
  const updatedAt = new Date().toISOString();
  return ChatRepository.update(id, userId, { title, updatedAt });
}

/**
 * Delete a chat.
 */
async function deleteChat(userId: string, id: string): Promise<boolean> {
  return ChatRepository.delete(id, userId);
}

/**
 * Verify chat ownership.
 */
async function verifyOwnership(
  chatId: string,
  userId: string,
): Promise<boolean> {
  return ChatRepository.verifyChatOwnership(chatId, userId);
}

/**
 * Touch chat (update timestamp).
 * Defense-in-depth: includes userId for authorization.
 */
async function touch(chatId: string, userId: string): Promise<void> {
  await ChatRepository.touch(chatId, userId);
}

export const ChatService = {
  getAll,
  create,
  update,
  delete: deleteChat,
  verifyOwnership,
  touch,
} as const;
