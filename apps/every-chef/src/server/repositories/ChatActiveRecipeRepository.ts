import { db } from "@/db";
import { chatActiveRecipes, chats } from "@/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * Find all active recipes for a user (across all their chats).
 * Returns flat data without nested recipe.
 */
async function findAllByUserId(userId: string) {
  return db
    .select({
      id: chatActiveRecipes.id,
      chatId: chatActiveRecipes.chatId,
      recipeId: chatActiveRecipes.recipeId,
      activatedAt: chatActiveRecipes.activatedAt,
    })
    .from(chatActiveRecipes)
    .innerJoin(chats, eq(chatActiveRecipes.chatId, chats.id))
    .where(eq(chats.userId, userId));
}

/**
 * Add a recipe to a chat's active recipes.
 * Note: Caller (service layer) is responsible for verifying ownership.
 */
async function add(
  id: string,
  chatId: string,
  recipeId: string,
  activatedAt: string,
): Promise<{
  id: string;
  chatId: string;
  recipeId: string;
  activatedAt: string;
}> {
  // Use INSERT OR IGNORE to handle the unique constraint gracefully
  await db
    .insert(chatActiveRecipes)
    .values({
      id,
      chatId,
      recipeId,
      activatedAt,
    })
    .onConflictDoNothing();

  return { id, chatId, recipeId, activatedAt };
}

/**
 * Remove a recipe from a chat's active recipes.
 * Note: Caller (service layer) is responsible for verifying ownership.
 */
async function remove(chatId: string, recipeId: string): Promise<boolean> {
  const result = await db
    .delete(chatActiveRecipes)
    .where(
      and(
        eq(chatActiveRecipes.chatId, chatId),
        eq(chatActiveRecipes.recipeId, recipeId),
      ),
    )
    .returning();

  return result.length > 0;
}

export const ChatActiveRecipeRepository = {
  findAllByUserId,
  add,
  remove,
} as const;
