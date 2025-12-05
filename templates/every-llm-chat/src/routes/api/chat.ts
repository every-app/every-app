import { createFileRoute } from "@tanstack/react-router";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "cloudflare:workers";
import type { UIMessage } from "ai";
import { db } from "@/db";
import { chats } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { chatRequestSchema } from "@/server/utils/validation";
import { MessageService } from "@/server/services/MessageService";
import { withAuth, errorResponse } from "@/server/utils/api";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: withAuth(async ({ request, userId }) => {
        try {
          // Parse request body (JSON only)
          const rawData = await request.json();

          // Validate with Zod
          const validationResult =
            await chatRequestSchema.safeParseAsync(rawData);

          if (!validationResult.success) {
            console.error("Validation errors:", validationResult.error.issues);
            const firstError = validationResult.error.issues[0];
            return errorResponse(firstError?.message || "Invalid request", 400);
          }

          const { chatId, message: newUserMessage } = validationResult.data;

          // Verify chat ownership AND existence in one query
          const chatOwnership = await db
            .select({ id: chats.id })
            .from(chats)
            .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
            .limit(1);

          if (chatOwnership.length === 0) {
            return errorResponse("Chat not found or unauthorized", 404);
          }

          // Save user message to database using service
          await MessageService.saveUserMessage(
            chatId,
            userId,
            newUserMessage as UIMessage,
          );

          // Get all messages for the chat and convert to OpenAI format
          const normalizedMessages = await MessageService.getMessagesForChat(
            chatId,
            userId,
          );
          const openaiMessages = await MessageService.toOpenAIFormat(
            normalizedMessages,
            userId,
          );

          // Create OpenAI provider instance
          const openaiProvider = createOpenAI({
            apiKey: env.OPENAI_API_KEY,
          });

          // Stream text with AI SDK
          const result = streamText({
            model: openaiProvider("gpt-5"),
            system: "You are a helpful AI assistant.",
            messages: openaiMessages,
            providerOptions: {
              openai: {
                reasoningEffort: "minimal",
              },
            },
            onFinish: async ({ text }) => {
              // Save assistant message to database using service
              await MessageService.saveAssistantMessage(chatId, userId, text);

              // Update chat's updatedAt timestamp
              await db
                .update(chats)
                .set({ updatedAt: new Date().toISOString() })
                .where(eq(chats.id, chatId));
            },
          });

          // Return streaming response
          return result.toUIMessageStreamResponse();
        } catch (error) {
          console.error("Chat error:", error);
          return errorResponse("Failed to process chat request", 500);
        }
      }),
    },
  },
});
