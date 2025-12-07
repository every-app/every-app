import { db } from "@/db";
import {
  messages,
  messageParts,
  textMessageParts,
  imageMessageParts,
  toolInvocationMessageParts,
  files,
  chats,
  type ToolInvocationState,
} from "@/db/schema";
import { eq, asc } from "drizzle-orm";

/**
 * Creates a message record in the database.
 * Note: Caller (service layer) is responsible for verifying chat ownership.
 */
async function createMessage(
  id: string,
  chatId: string,
  role: "user" | "assistant",
  createdAt: string,
): Promise<void> {
  await db.insert(messages).values({
    id,
    chatId,
    role,
    createdAt,
  });
}

/**
 * Creates a message part record.
 */
async function createMessagePart(
  messageId: string,
  type: "text" | "image" | "tool-invocation",
  order: number,
): Promise<string> {
  const partId = crypto.randomUUID();
  await db.insert(messageParts).values({
    id: partId,
    messageId,
    type,
    order: order.toString(),
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
  mimeType: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(imageMessageParts).values({
    id,
    partId,
    fileId,
    mimeType,
  });
}

/**
 * Creates a tool invocation message part.
 */
async function createToolInvocationMessagePart(
  partId: string,
  toolCallId: string,
  toolName: string,
  state: ToolInvocationState,
  input: unknown,
  output?: unknown,
): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(toolInvocationMessageParts).values({
    id,
    partId,
    toolCallId,
    toolName,
    state,
    input: JSON.stringify(input),
    output: output !== undefined ? JSON.stringify(output) : null,
  });
}

/**
 * Updates a tool invocation message part with the result.
 */
async function updateToolInvocationResult(
  toolCallId: string,
  state: ToolInvocationState,
  output: unknown,
): Promise<void> {
  await db
    .update(toolInvocationMessageParts)
    .set({
      state,
      output: JSON.stringify(output),
    })
    .where(eq(toolInvocationMessageParts.toolCallId, toolCallId));
}

/**
 * Creates a file record in the database.
 */
async function createFile(
  r2Key: string,
  mimeType: string,
  size: number,
): Promise<string> {
  const fileId = crypto.randomUUID();
  await db.insert(files).values({
    id: fileId,
    r2Key,
    mimeType,
    size: size.toString(),
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
 * Verifies that a tool call belongs to a chat owned by the specified user.
 * Defense-in-depth: joins through toolInvocationMessageParts → messageParts → messages → chats
 * to verify ownership before allowing updates.
 */
async function verifyToolCallOwnership(
  toolCallId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .select({ chatUserId: chats.userId })
    .from(toolInvocationMessageParts)
    .innerJoin(
      messageParts,
      eq(toolInvocationMessageParts.partId, messageParts.id),
    )
    .innerJoin(messages, eq(messageParts.messageId, messages.id))
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(eq(toolInvocationMessageParts.toolCallId, toolCallId))
    .limit(1);

  if (result.length === 0) {
    return false;
  }

  return result[0].chatUserId === userId;
}

/**
 * Retrieves all messages for a chat with their content parts (raw database format).
 * Uses Drizzle's relational query API to fetch everything in a single query.
 * Note: Caller (service layer) is responsible for verifying chat ownership.
 */
async function getMessagesByChatIdRaw(chatId: string) {
  return db.query.messages.findMany({
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
          toolInvocationPart: true,
        },
      },
    },
  });
}

export const MessageRepository = {
  createMessage,
  createMessagePart,
  createTextMessagePart,
  createImageMessagePart,
  createToolInvocationMessagePart,
  updateToolInvocationResult,
  createFile,
  findFileByR2Key,
  verifyToolCallOwnership,
  getMessagesByChatIdRaw,
} as const;
