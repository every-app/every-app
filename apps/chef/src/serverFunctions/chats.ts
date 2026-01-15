import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/tanstack";
import { ChatService } from "@/server/services/ChatService";
import { MessageService } from "@/server/services/MessageService";
import { ChatActiveRecipeService } from "@/server/services/ChatActiveRecipeService";
import { z } from "zod";

interface ServerContext {
  userId: string;
  userEmail: string;
}

// Zod schemas for input validation
const createChatSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(255),
});

const updateChatSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(255),
});

const deleteChatSchema = z.object({
  id: z.string().uuid(),
});

const getMessagesSchema = z.object({
  chatId: z.string().uuid(),
});

const activeRecipeSchema = z.object({
  chatId: z.string().uuid(),
  recipeId: z.string().uuid(),
});

export const getChats = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: ServerContext }) => {
    return ChatService.getAll(context.userId);
  });

export const createChat = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(createChatSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof createChatSchema>;
      context: ServerContext;
    }) => {
      return ChatService.create(context.userId, data.title, data.id);
    },
  );

export const updateChat = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(updateChatSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof updateChatSchema>;
      context: ServerContext;
    }) => {
      const chat = await ChatService.update(
        context.userId,
        data.id,
        data.title,
      );
      if (!chat) {
        throw new Error("Chat not found or unauthorized");
      }
      return chat;
    },
  );

export const deleteChat = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(deleteChatSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof deleteChatSchema>;
      context: ServerContext;
    }) => {
      const success = await ChatService.delete(context.userId, data.id);
      if (!success) {
        throw new Error("Chat not found or unauthorized");
      }
      return { success: true };
    },
  );

export const getMessages = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(getMessagesSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof getMessagesSchema>;
      context: ServerContext;
    }) => {
      const messages = await MessageService.getMessagesForChat(
        data.chatId,
        context.userId,
      );

      // Return messages in UI format
      return MessageService.toUIMessages(messages);
    },
  );

// === Active Recipes ===

// Get all active recipes for user (across all chats, flat data for TanstackDB)
export const getAllActiveRecipes = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: ServerContext }) => {
    return ChatActiveRecipeService.getAllActiveRecipes(context.userId);
  });

export const addActiveRecipe = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(activeRecipeSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof activeRecipeSchema>;
      context: ServerContext;
    }) => {
      const result = await ChatActiveRecipeService.addActiveRecipe(
        data.chatId,
        data.recipeId,
        context.userId,
      );
      if (!result) {
        throw new Error("Failed to add recipe - chat or recipe not found");
      }
      return result;
    },
  );

export const removeActiveRecipe = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(activeRecipeSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof activeRecipeSchema>;
      context: ServerContext;
    }) => {
      const success = await ChatActiveRecipeService.removeActiveRecipe(
        data.chatId,
        data.recipeId,
        context.userId,
      );
      if (!success) {
        throw new Error("Failed to remove recipe - not found or unauthorized");
      }
      return { success: true };
    },
  );

// Save tool output (user's decision on tool calls)
const saveToolOutputSchema = z.object({
  toolCallId: z.string(),
  output: z.record(z.string(), z.unknown()),
});

export const saveToolOutput = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(saveToolOutputSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof saveToolOutputSchema>;
      context: ServerContext;
    }) => {
      // Defense-in-depth: verify the tool call belongs to a chat owned by this user
      const isOwned = await MessageService.verifyToolCallOwnership(
        data.toolCallId,
        context.userId,
      );
      if (!isOwned) {
        throw new Error("Tool call not found or unauthorized");
      }

      await MessageService.updateToolInvocationResult(
        data.toolCallId,
        data.output,
      );
      return { success: true };
    },
  );

// Start cooking with a recipe (atomic operation for TanstackDB optimistic action)
const startCookingSchema = z.object({
  chatId: z.string().uuid(),
  chatTitle: z.string().min(1).max(255),
  activeRecipeId: z.string().uuid(),
  recipeId: z.string().uuid(),
  isNewChat: z.boolean(),
});

export const startCookingWithRecipe = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(startCookingSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof startCookingSchema>;
      context: ServerContext;
    }) => {
      // If creating a new chat, create it first with the client-provided ID
      if (data.isNewChat) {
        await ChatService.create(context.userId, data.chatTitle, data.chatId);
      }

      // Add the recipe to active recipes
      const result = await ChatActiveRecipeService.addActiveRecipe(
        data.chatId,
        data.recipeId,
        context.userId,
      );

      if (!result) {
        throw new Error("Failed to add recipe - chat or recipe not found");
      }

      return { chatId: data.chatId };
    },
  );
