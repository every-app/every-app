import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatActiveRecipes, chats, recipes } from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { MessageService } from "@/server/services/MessageService";
import {
  activeRecipeSchema,
  createChatSchema,
  deleteChatSchema,
  getMessagesSchema,
  saveToolOutputSchema,
  startCookingSchema,
  updateChatSchema,
} from "@/types/schemas/chats";

export const getChats = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    return db
      .select()
      .from(chats)
      .where(eq(chats.userId, context.userId))
      .orderBy(desc(chats.updatedAt));
  });

export const createChat = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator(createChatSchema)
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const chat = {
      id: data.id,
      userId: context.userId,
      title: data.title,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(chats).values(chat);
    return chat;
  });

export const updateChat = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator(updateChatSchema)
  .handler(async ({ data, context }) => {
    const updatedChats = await db
      .update(chats)
      .set({ title: data.title, updatedAt: new Date().toISOString() })
      .where(and(eq(chats.id, data.id), eq(chats.userId, context.userId)))
      .returning();

    if (updatedChats.length === 0) {
      throw new Error("Chat not found or unauthorized");
    }

    return updatedChats[0];
  });

export const deleteChat = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator(deleteChatSchema)
  .handler(async ({ data, context }) => {
    const deletedChats = await db
      .delete(chats)
      .where(and(eq(chats.id, data.id), eq(chats.userId, context.userId)))
      .returning({ id: chats.id });

    if (deletedChats.length === 0) {
      throw new Error("Chat not found or unauthorized");
    }

    return { success: true };
  });

export const getMessages = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator(getMessagesSchema)
  .handler(async ({ data, context }) => {
    const messages = await MessageService.getMessagesForChat(
      data.chatId,
      context.userId,
    );

    // Return messages in UI format
    return MessageService.toUIMessages(messages);
  });

export const getAllActiveRecipes = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    return db
      .select({
        id: chatActiveRecipes.id,
        chatId: chatActiveRecipes.chatId,
        recipeId: chatActiveRecipes.recipeId,
        activatedAt: chatActiveRecipes.activatedAt,
      })
      .from(chatActiveRecipes)
      .innerJoin(chats, eq(chatActiveRecipes.chatId, chats.id))
      .where(eq(chats.userId, context.userId));
  });

export const addActiveRecipe = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator(activeRecipeSchema)
  .handler(async ({ data, context }) => {
    const ownedChat = await db.query.chats.findFirst({
      where: and(eq(chats.id, data.chatId), eq(chats.userId, context.userId)),
    });
    const ownedRecipe = await db.query.recipes.findFirst({
      where: and(
        eq(recipes.id, data.recipeId),
        eq(recipes.userId, context.userId),
      ),
    });

    if (!ownedChat || !ownedRecipe) {
      throw new Error("Failed to add recipe - chat or recipe not found");
    }

    const activeRecipe = {
      id: crypto.randomUUID(),
      chatId: data.chatId,
      recipeId: data.recipeId,
      activatedAt: new Date().toISOString(),
    };

    await db
      .insert(chatActiveRecipes)
      .values(activeRecipe)
      .onConflictDoNothing();

    return activeRecipe;
  });

export const removeActiveRecipe = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator(activeRecipeSchema)
  .handler(async ({ data, context }) => {
    const ownedChat = await db.query.chats.findFirst({
      where: and(eq(chats.id, data.chatId), eq(chats.userId, context.userId)),
    });

    if (!ownedChat) {
      throw new Error("Failed to remove recipe - not found or unauthorized");
    }

    const removedRecipes = await db
      .delete(chatActiveRecipes)
      .where(
        and(
          eq(chatActiveRecipes.chatId, data.chatId),
          eq(chatActiveRecipes.recipeId, data.recipeId),
        ),
      )
      .returning({ id: chatActiveRecipes.id });

    if (removedRecipes.length === 0) {
      throw new Error("Failed to remove recipe - not found or unauthorized");
    }

    return { success: true };
  });

export const saveToolOutput = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator(saveToolOutputSchema)
  .handler(async ({ data, context }) => {
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
  });

export const startCookingWithRecipe = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator(startCookingSchema)
  .handler(async ({ data, context }) => {
    if (data.isNewChat) {
      const now = new Date().toISOString();
      await db.insert(chats).values({
        id: data.chatId,
        userId: context.userId,
        title: data.chatTitle,
        createdAt: now,
        updatedAt: now,
      });
    }

    const ownedChat = await db.query.chats.findFirst({
      where: and(eq(chats.id, data.chatId), eq(chats.userId, context.userId)),
    });
    const ownedRecipe = await db.query.recipes.findFirst({
      where: and(
        eq(recipes.id, data.recipeId),
        eq(recipes.userId, context.userId),
      ),
    });

    if (!ownedChat || !ownedRecipe) {
      throw new Error("Failed to add recipe - chat or recipe not found");
    }

    await db
      .insert(chatActiveRecipes)
      .values({
        id: data.activeRecipeId,
        chatId: data.chatId,
        recipeId: data.recipeId,
        activatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing();

    return { chatId: data.chatId };
  });
