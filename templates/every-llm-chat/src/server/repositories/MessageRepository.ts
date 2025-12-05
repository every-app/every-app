import { db } from "@/db";
import {
  messages,
  messageParts,
  textMessageParts,
  imageMessageParts,
  files,
  chats,
} from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";

// Types for our normalized message structure
// These match the AI SDK's UIMessagePart format
type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string };

export type NormalizedMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  createdAt: string;
  content: MessagePart[];
};

/**
 * Verifies that a chat belongs to the given user.
 * Returns true if the chat exists and belongs to the user.
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
 * Creates a message record in the database.
 */
async function createMessage(
  id: string,
  chatId: string,
  role: "user" | "assistant",
): Promise<void> {
  await db.insert(messages).values({
    id,
    chatId,
    role,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Creates a message part record.
 */
async function createMessagePart(
  messageId: string,
  type: "text" | "image",
  order: number,
): Promise<string> {
  const partId = crypto.randomUUID();
  await db.insert(messageParts).values({
    id: partId,
    messageId,
    type,
    order,
    createdAt: new Date().toISOString(),
  });
  return partId;
}

/**
 * Creates a text message part.
 */
async function createTextMessagePart(
  partId: string,
  text: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(textMessageParts).values({
    id,
    partId,
    text,
  });
}

/**
 * Creates an image message part.
 */
async function createImageMessagePart(
  partId: string,
  fileId: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(imageMessageParts).values({
    id,
    partId,
    fileId,
  });
}

/**
 * Creates a file record in the database.
 */
async function createFile(
  userId: string,
  r2Key: string,
  mimeType: string,
  size: number,
): Promise<string> {
  const fileId = crypto.randomUUID();
  await db.insert(files).values({
    id: fileId,
    userId,
    r2Key,
    mimeType,
    size,
    uploadedAt: new Date().toISOString(),
  });
  return fileId;
}

/**
 * Finds a file by its R2 key.
 */
async function findFileByR2Key(r2Key: string) {
  const result = await db
    .select()
    .from(files)
    .where(eq(files.r2Key, r2Key))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * Retrieves all messages for a chat with their content parts.
 * Uses Drizzle's relational query API to fetch everything in a single query.
 */
async function getMessagesByChatId(
  chatId: string,
): Promise<NormalizedMessage[]> {
  // Use relational query to fetch messages with all their parts
  const chatMessages = await db.query.messages.findMany({
    where: eq(messages.chatId, chatId),
    orderBy: [asc(messages.createdAt)],
    with: {
      parts: {
        orderBy: [asc(messageParts.order)],
        with: {
          textPart: true,
          imagePart: {
            with: {
              file: true,
            },
          },
        },
      },
    },
  });

  // Transform the nested structure into our NormalizedMessage format
  const normalizedMessages: NormalizedMessage[] = chatMessages.map((msg) => {
    const content: MessagePart[] = [];

    for (const part of msg.parts) {
      if (part.type === "text" && part.textPart) {
        content.push({
          type: "text",
          text: part.textPart.text,
        });
      } else if (part.type === "image" && part.imagePart?.file) {
        content.push({
          type: "file",
          url: part.imagePart.file.r2Key,
          mediaType: part.imagePart.file.mimeType,
        });
      }
    }

    return {
      id: msg.id,
      chatId: msg.chatId,
      role: msg.role,
      createdAt: msg.createdAt,
      content,
    };
  });

  return normalizedMessages;
}

/**
 * MessageRepository object - provides better intellisense when using import * as syntax
 * This groups all the exported functions for convenience
 */
export const MessageRepository = {
  verifyChatOwnership,
  createMessage,
  createMessagePart,
  createTextMessagePart,
  createImageMessagePart,
  createFile,
  findFileByR2Key,
  getMessagesByChatId,
} as const;
