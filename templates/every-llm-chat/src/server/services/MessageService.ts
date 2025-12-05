import type { UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import { R2Utils } from "../utils/r2";
import {
  MessageRepository,
  type NormalizedMessage,
} from "../repositories/MessageRepository";

/**
 * Creates a text message with authentication check.
 */
async function createTextMessage(
  chatId: string,
  userId: string,
  role: "user" | "assistant",
  text: string,
  messageId?: string,
): Promise<string> {
  // Verify chat ownership
  const hasAccess = await MessageRepository.verifyChatOwnership(chatId, userId);
  if (!hasAccess) {
    throw new Error("Unauthorized: Chat not found or access denied");
  }

  const msgId = messageId || crypto.randomUUID();

  // Create message
  await MessageRepository.createMessage(msgId, chatId, role);

  // Create a text part
  const partId = await MessageRepository.createMessagePart(msgId, "text", 0);
  await MessageRepository.createTextMessagePart(partId, text);

  return msgId;
}

/**
 * Saves an assistant response (always text for now).
 * Verifies chat ownership before saving.
 */
async function saveAssistantMessage(
  chatId: string,
  userId: string,
  text: string,
): Promise<string> {
  return createTextMessage(chatId, userId, "assistant", text);
}

/**
 * Saves a user message from the UI format.
 * Handles both text and image parts.
 * Verifies chat ownership before saving.
 */
async function saveUserMessage(
  chatId: string,
  userId: string,
  uiMessage: UIMessage,
): Promise<void> {
  // Verify chat ownership
  const hasAccess = await MessageRepository.verifyChatOwnership(chatId, userId);
  if (!hasAccess) {
    throw new Error("Unauthorized: Chat not found or access denied");
  }

  // Create the message
  await MessageRepository.createMessage(uiMessage.id, chatId, "user");

  // Process each part of the message
  let order = 0;
  for (const part of uiMessage.parts) {
    if (part.type === "text") {
      const partId = await MessageRepository.createMessagePart(
        uiMessage.id,
        "text",
        order++,
      );
      await MessageRepository.createTextMessagePart(partId, part.text);
    } else if (part.type === "file") {
      // Extract file info from the part
      const url = "url" in part ? (part.url as string) : "";
      const mimeType =
        "mimeType" in part && typeof part.mimeType === "string"
          ? part.mimeType
          : "image/jpeg";

      // If it's an R2 key (not a data URL), find the file record
      // For data URLs, we need to handle upload separately (this happens in the upload endpoint)
      if (!url.startsWith("data:") && url.includes("/")) {
        // Security check: Ensure the R2 key belongs to the user
        // Key format: userId/chatId/fileId.ext
        if (!url.startsWith(`${userId}/`)) {
          console.warn(
            `Blocked attempt to access unauthorized file: ${url} by user ${userId}`,
          );
          continue; // Skip this part if unauthorized
        }

        const fileRecord = await MessageRepository.findFileByR2Key(url);

        if (fileRecord) {
          const partId = await MessageRepository.createMessagePart(
            uiMessage.id,
            "image",
            order++,
          );
          await MessageRepository.createImageMessagePart(partId, fileRecord.id);
        }
      }
    }
  }
}

/**
 * Retrieves all messages for a chat with authentication check.
 */
async function getMessagesForChat(
  chatId: string,
  userId: string,
): Promise<NormalizedMessage[]> {
  // Verify chat ownership
  const hasAccess = await MessageRepository.verifyChatOwnership(chatId, userId);
  if (!hasAccess) {
    throw new Error("Unauthorized: Chat not found or access denied");
  }

  return MessageRepository.getMessagesByChatId(chatId);
}

/**
 * Converts normalized messages to UI format for the frontend.
 * Private helper function - not exported.
 */
function toUIMessages(normalizedMessages: NormalizedMessage[]) {
  return normalizedMessages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    parts: msg.content,
  })) as UIMessage[];
}

/**
 * Converts normalized messages to OpenAI format with R2 URL processing.
 * This handles converting R2 keys to data URLs for the LLM.
 * Requires userId for authorization check when fetching images from R2.
 */
async function toOpenAIFormat(
  normalizedMessages: NormalizedMessage[],
  userId: string,
) {
  // Convert to UI messages first
  const uiMessages = toUIMessages(normalizedMessages);

  // Process R2 URLs to data URLs
  const processedMessages = await Promise.all(
    uiMessages.map(async (message) => ({
      ...message,
      parts: await Promise.all(
        message.parts.map(async (part) => {
          if (
            part.type === "file" &&
            "url" in part &&
            typeof part.url === "string"
          ) {
            // If it's a data URL, pass through
            if (part.url.startsWith("data:")) {
              return part;
            }

            // If it's an R2 key, convert to data URL
            if (part.url.includes("/") && !part.url.startsWith("http")) {
              const mimeType =
                "mimeType" in part && typeof part.mimeType === "string"
                  ? part.mimeType
                  : "image/jpeg";

              const dataUrl = await R2Utils.r2ToDataUrl(
                part.url,
                mimeType,
                userId,
              );
              return {
                ...part,
                url: dataUrl,
              };
            }
          }
          return part;
        }),
      ),
    })),
  );

  // Convert to OpenAI format using AI SDK
  const messagesWithoutId = processedMessages.map(({ id, ...msg }) => msg);
  return convertToModelMessages(messagesWithoutId);
}

/**
 * MessageService object - provides better intellisense when using import * as syntax
 * This groups all the exported functions for convenience
 */
export const MessageService = {
  saveUserMessage,
  saveAssistantMessage,
  getMessagesForChat,
  toOpenAIFormat,
} as const;
