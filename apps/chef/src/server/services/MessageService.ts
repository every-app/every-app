import type { UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import { MessageRepository } from "../repositories/MessageRepository";
import { ChatRepository } from "../repositories/ChatRepository";
import { R2Utils } from "../utils/r2";
import type { ToolInvocationState } from "@/db/schema";

// Types for our normalized message structure
// These match the AI SDK's UIMessagePart format
type ToolInvocationPart = {
  type: "tool-invocation";
  toolCallId: string;
  toolName: string;
  state: ToolInvocationState;
  input: unknown;
  output?: unknown;
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string }
  | ToolInvocationPart;

type NormalizedMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  createdAt: string;
  content: MessagePart[];
};

/**
 * Creates a text message with authentication check.
 * Verifies chat ownership before creating.
 */
async function createTextMessage(
  chatId: string,
  userId: string,
  role: "user" | "assistant",
  text: string,
  messageId?: string,
): Promise<string> {
  // Verify chat ownership before creating message
  const hasAccess = await ChatRepository.verifyChatOwnership(chatId, userId);
  if (!hasAccess) {
    throw new Error("Unauthorized: Chat not found or access denied");
  }

  const msgId = messageId || crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await MessageRepository.createMessage(msgId, chatId, role, createdAt);

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
 * Saves a text part for a message.
 */
async function saveTextPart(
  messageId: string,
  text: string,
  order: number,
): Promise<void> {
  const partId = await MessageRepository.createMessagePart(
    messageId,
    "text",
    order,
  );
  await MessageRepository.createTextMessagePart(partId, text);
}

/**
 * Saves a file/image part for a message.
 * Returns true if saved, false if skipped (unauthorized or not found).
 */
async function saveFilePart(
  messageId: string,
  url: string,
  mimeType: string,
  order: number,
  userId: string,
): Promise<boolean> {
  // Skip data URLs - only process R2 keys
  if (url.startsWith("data:") || !url.includes("/")) {
    return false;
  }

  // Security check: Ensure the R2 key belongs to the user
  // Key format: userId/chatId/fileId.ext
  if (!url.startsWith(`${userId}/`)) {
    console.warn(
      `Blocked attempt to access unauthorized file: ${url} by user ${userId}`,
    );
    return false;
  }

  const fileRecord = await MessageRepository.findFileByR2Key(url);
  if (!fileRecord) {
    return false;
  }

  const partId = await MessageRepository.createMessagePart(
    messageId,
    "image",
    order,
  );
  await MessageRepository.createImageMessagePart(
    partId,
    fileRecord.id,
    mimeType,
  );
  return true;
}

/**
 * Saves a tool invocation part for a message.
 */
async function saveToolInvocationPart(
  messageId: string,
  toolCallId: string,
  toolName: string,
  state: ToolInvocationState,
  input: unknown,
  order: number,
  output?: unknown,
): Promise<void> {
  const partId = await MessageRepository.createMessagePart(
    messageId,
    "tool-invocation",
    order,
  );
  await MessageRepository.createToolInvocationMessagePart(
    partId,
    toolCallId,
    toolName,
    state,
    input,
    output,
  );
}

/**
 * Updates a tool invocation with its result.
 */
async function updateToolInvocationResult(
  toolCallId: string,
  output: unknown,
): Promise<void> {
  await MessageRepository.updateToolInvocationResult(
    toolCallId,
    "result",
    output,
  );
}

/**
 * Verifies that a tool call belongs to a chat owned by the specified user.
 * Defense-in-depth: delegates to repository which joins through the full chain.
 */
async function verifyToolCallOwnership(
  toolCallId: string,
  userId: string,
): Promise<boolean> {
  return MessageRepository.verifyToolCallOwnership(toolCallId, userId);
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
  // Verify chat ownership before creating message
  const hasAccess = await ChatRepository.verifyChatOwnership(chatId, userId);
  if (!hasAccess) {
    throw new Error("Unauthorized: Chat not found or access denied");
  }

  const createdAt = new Date().toISOString();
  await MessageRepository.createMessage(
    uiMessage.id,
    chatId,
    "user",
    createdAt,
  );

  // Process each part of the message
  let order = 0;
  for (const part of uiMessage.parts) {
    if (part.type === "text") {
      await saveTextPart(uiMessage.id, part.text, order++);
    } else if (part.type === "file") {
      const url = "url" in part ? (part.url as string) : "";
      const mimeType =
        "mimeType" in part && typeof part.mimeType === "string"
          ? part.mimeType
          : "image/jpeg";

      const saved = await saveFilePart(
        uiMessage.id,
        url,
        mimeType,
        order,
        userId,
      );
      if (saved) {
        order++;
      }
    }
  }
}

/**
 * Simple save for text-only user messages.
 */
async function saveUserTextMessage(
  chatId: string,
  userId: string,
  content: string,
  messageId?: string,
): Promise<string> {
  return createTextMessage(chatId, userId, "user", content, messageId);
}

/**
 * Transforms raw database messages into NormalizedMessage format.
 */
function transformToNormalizedMessages(
  rawMessages: Awaited<
    ReturnType<typeof MessageRepository.getMessagesByChatIdRaw>
  >,
): NormalizedMessage[] {
  return rawMessages.map((msg) => {
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
      } else if (part.type === "tool-invocation" && part.toolInvocationPart) {
        const toolPart = part.toolInvocationPart;
        content.push({
          type: "tool-invocation",
          toolCallId: toolPart.toolCallId,
          toolName: toolPart.toolName,
          state: toolPart.state as ToolInvocationState,
          input: JSON.parse(toolPart.input),
          output: toolPart.output ? JSON.parse(toolPart.output) : undefined,
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
}

/**
 * Retrieves all messages for a chat with authentication check.
 * Verifies chat ownership before fetching.
 */
async function getMessagesForChat(
  chatId: string,
  userId: string,
): Promise<NormalizedMessage[]> {
  // Verify chat ownership before fetching messages
  const hasAccess = await ChatRepository.verifyChatOwnership(chatId, userId);
  if (!hasAccess) {
    throw new Error("Unauthorized: Chat not found or access denied");
  }

  const rawMessages = await MessageRepository.getMessagesByChatIdRaw(chatId);
  return transformToNormalizedMessages(rawMessages);
}

// Tool invocation part type for UI
// Using indexed signature with {} to match what TanStack expects
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type ToolInvocationUIPart = {
  type: "tool-invocation";
  toolCallId: string;
  toolName: string;
  state: ToolInvocationState;
  input: { [key: string]: {} };
  output?: { [key: string]: {} };
};

type UIPart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string }
  | ToolInvocationUIPart;

// Type for messages that can be passed to convertToModelMessages
type ModelMessagePart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string };

type ModelMessage = {
  role: "user" | "assistant" | "system";
  parts: ModelMessagePart[];
};

/**
 * Converts normalized messages to UI format for the frontend.
 */
function toUIMessages(normalizedMessages: NormalizedMessage[]): Array<{
  id: string;
  role: "user" | "assistant" | "system";
  parts: UIPart[];
}> {
  return normalizedMessages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant" | "system",
    parts: msg.content.map((part): UIPart => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text };
      }
      if (part.type === "file") {
        return {
          type: "file" as const,
          url: part.url,
          mediaType: part.mediaType,
        };
      }
      if (part.type === "tool-invocation") {
        return {
          type: "tool-invocation" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          state: part.state,
          // eslint-disable-next-line @typescript-eslint/no-empty-object-type
          input: part.input as { [key: string]: {} },
          // eslint-disable-next-line @typescript-eslint/no-empty-object-type
          output: part.output as { [key: string]: {} } | undefined,
        };
      }
      return { type: "text" as const, text: "" };
    }),
  }));
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
              const mediaType =
                "mediaType" in part && typeof part.mediaType === "string"
                  ? part.mediaType
                  : "image/jpeg";

              try {
                const dataUrl = await R2Utils.r2ToDataUrl(
                  part.url,
                  mediaType,
                  userId,
                );
                return {
                  ...part,
                  url: dataUrl,
                };
              } catch (error) {
                console.error("Failed to load image for OpenAI:", error);
                return part;
              }
            }
          }
          return part;
        }),
      ),
    })),
  );

  // Convert to OpenAI format using AI SDK
  // Filter out tool invocation parts since they're not supported by convertToModelMessages
  const messagesForConversion: ModelMessage[] = processedMessages
    .map((msg) => ({
      role: msg.role,
      parts: msg.parts.filter(
        (part): part is ModelMessagePart =>
          part.type === "text" || part.type === "file",
      ),
    }))
    .filter((msg) => msg.parts.length > 0);

  return convertToModelMessages(messagesForConversion);
}

export const MessageService = {
  saveUserMessage,
  saveUserTextMessage,
  saveAssistantMessage,
  saveToolInvocationPart,
  updateToolInvocationResult,
  verifyToolCallOwnership,
  getMessagesForChat,
  toUIMessages,
  toOpenAIFormat,
} as const;
