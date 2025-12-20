import { createFileRoute } from "@tanstack/react-router";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { authenticateRequest, getAuthConfig } from "@every-app/sdk/server";
import { env } from "cloudflare:workers";
import { chatRequestSchema } from "@/server/utils/validation";
import { MessageService } from "@/server/services/MessageService";
import { ChatService } from "@/server/services/ChatService";
import { recipeTools } from "@/server/tools/recipeTools";
import type { UIMessage } from "ai";

const COOKING_SYSTEM_PROMPT = `You are a helpful and friendly cooking assistant. Your role is to help users with:

1. **Recipe suggestions** - Help users find recipes based on ingredients they have, dietary restrictions, or cuisine preferences
2. **Cooking guidance** - Provide step-by-step cooking instructions, timing tips, and technique explanations
3. **Ingredient substitutions** - Suggest alternatives when users are missing ingredients
4. **Cooking troubleshooting** - Help diagnose and fix cooking problems
5. **Meal planning** - Help users plan meals for the week

When providing recipes, format them clearly with:
- A title
- An ingredients list (use bullet points)
- Numbered step-by-step instructions
	- These should err on the side of being succinct and less information rather than being verbose.
		- It should be like a recipe that a grandmother or good friend would write down, minus the overly casual tone.
- Optional tips or variations

## Saving Recipes

When you suggest a complete recipe, ask the user if they would like to save it. If the user confirms they want to save a recipe, use the \`promptUserWithRecipeUpdate\` tool to let them choose whether to:
- Create a new recipe
- Update an existing recipe they have active in the chat
- Ignore and get other suggestions

When using the tool, provide:
- \`title\`: A clear, descriptive title for the recipe
- \`content\`: The complete recipe in markdown format (including ingredients list and step-by-step instructions)

After the user makes their choice:
- If they chose "create": Confirm the new recipe has been created
- If they chose "update": Confirm which recipe was updated
- If they chose "ignore": Offer alternative recipe suggestions

Be encouraging, concise, and practical. If users are actively cooking, focus on being helpful and responsive to their immediate needs.`;

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          // Authenticate the request
          const authConfig = getAuthConfig();
          const session = await authenticateRequest(authConfig, request);

          if (!session || !session.sub) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }

          const userId = session.sub;

          // Parse request body
          const rawData = await request.json();

          // Validate with Zod
          const validationResult =
            await chatRequestSchema.safeParseAsync(rawData);

          if (!validationResult.success) {
            console.error("Validation errors:", validationResult.error.issues);
            const firstError = validationResult.error.issues[0];
            return new Response(
              JSON.stringify({
                error: firstError?.message || "Invalid request",
                path: firstError?.path?.join("."),
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          const { chatId, message: newUserMessage } = validationResult.data;

          // Verify chat ownership
          const hasAccess = await ChatService.verifyOwnership(chatId, userId);
          if (!hasAccess) {
            return new Response(
              JSON.stringify({ error: "Chat not found or unauthorized" }),
              {
                status: 404,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Save user message to database using service
          await MessageService.saveUserMessage(
            chatId,
            userId,
            newUserMessage as UIMessage,
          );

          // Update chat's updatedAt timestamp
          await ChatService.touch(chatId, userId);

          // Get all messages for the chat and convert to OpenAI format
          const normalizedMessages = await MessageService.getMessagesForChat(
            chatId,
            userId,
          );
          const openaiMessages =
            MessageService.toOpenAIFormat(normalizedMessages);

          // Create OpenAI provider instance
          const openaiProvider = createOpenAI({
            apiKey: env.OPENAI_API_KEY,
          });

          // Stream text with AI SDK
          const result = streamText({
            model: openaiProvider("gpt-5.1"),
            system: COOKING_SYSTEM_PROMPT,
            messages: openaiMessages,
            tools: recipeTools,
            onFinish: async ({ text, toolCalls }) => {
              // Save assistant message to database (if there's text)
              if (text) {
                await MessageService.saveAssistantMessage(chatId, userId, text);
              }

              // Save tool calls to database
              if (toolCalls && toolCalls.length > 0) {
                // Create a message ID for tool call parts if no text was generated
                const messageId = text ? undefined : crypto.randomUUID();

                if (messageId) {
                  // Create an assistant message to hold the tool calls
                  await MessageService.saveAssistantMessage(chatId, userId, "");
                }

                // Get the latest message ID
                const messages = await MessageService.getMessagesForChat(
                  chatId,
                  userId,
                );
                const latestMessage = messages[messages.length - 1];

                if (latestMessage && latestMessage.role === "assistant") {
                  let order = latestMessage.content.length;
                  for (const toolCall of toolCalls) {
                    // Use type assertion since toolCalls can be either static or dynamic
                    const input = (toolCall as { input?: unknown }).input;
                    await MessageService.saveToolInvocationPart(
                      latestMessage.id,
                      toolCall.toolCallId,
                      toolCall.toolName,
                      "call",
                      input,
                      order++,
                    );
                  }
                }
              }

              // Update chat's updatedAt timestamp
              await ChatService.touch(chatId, userId);
            },
          });

          // Return streaming response using UI message stream format
          return result.toUIMessageStreamResponse();
        } catch (error) {
          console.error("Chat error:", error);
          return new Response(
            JSON.stringify({ error: "Failed to process chat request" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      },
    },
  },
});
