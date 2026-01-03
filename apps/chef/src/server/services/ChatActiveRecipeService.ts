import { ChatActiveRecipeRepository } from "../repositories/ChatActiveRecipeRepository";
import { ChatRepository } from "../repositories/ChatRepository";
import { RecipeRepository } from "../repositories/RecipeRepository";

/**
 * Get all active recipes for a user (across all their chats, flat data).
 */
async function getAllActiveRecipes(userId: string) {
  return ChatActiveRecipeRepository.findAllByUserId(userId);
}

/**
 * Add a recipe to a chat's active recipes.
 * Verifies both chat and recipe ownership before adding.
 * Returns null if chat or recipe doesn't exist or user doesn't own them.
 */
async function addActiveRecipe(
  chatId: string,
  recipeId: string,
  userId: string,
): Promise<{
  id: string;
  chatId: string;
  recipeId: string;
  activatedAt: string;
} | null> {
  // Verify chat ownership
  const hasAccessToChat = await ChatRepository.verifyChatOwnership(
    chatId,
    userId,
  );
  if (!hasAccessToChat) {
    return null;
  }

  // Verify recipe ownership
  const recipe = await RecipeRepository.findByIdAndUserId(recipeId, userId);
  if (!recipe) {
    return null;
  }

  const id = crypto.randomUUID();
  const activatedAt = new Date().toISOString();

  return ChatActiveRecipeRepository.add(id, chatId, recipeId, activatedAt);
}

/**
 * Remove a recipe from a chat's active recipes.
 * Verifies chat ownership before removing.
 * Returns false if chat doesn't exist, user doesn't own it, or recipe wasn't active.
 */
async function removeActiveRecipe(
  chatId: string,
  recipeId: string,
  userId: string,
): Promise<boolean> {
  // Verify chat ownership
  const hasAccessToChat = await ChatRepository.verifyChatOwnership(
    chatId,
    userId,
  );
  if (!hasAccessToChat) {
    return false;
  }

  return ChatActiveRecipeRepository.remove(chatId, recipeId);
}

export const ChatActiveRecipeService = {
  getAllActiveRecipes,
  addActiveRecipe,
  removeActiveRecipe,
} as const;
