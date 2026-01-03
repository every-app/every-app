import { RecipeRepository } from "../repositories/RecipeRepository";
import type {
  CreateRecipeInput,
  UpdateRecipeInput,
} from "@/types/schemas/recipes";

/**
 * Get all recipes for a user.
 */
async function getAll(userId: string) {
  const recipes = await RecipeRepository.findAllByUserId(userId);
  return { recipes };
}

/**
 * Create a new recipe.
 */
async function create(userId: string, data: CreateRecipeInput) {
  await RecipeRepository.create({
    id: data.id,
    userId,
    title: data.title,
    content: data.content,
  });
  return { success: true };
}

/**
 * Update a recipe.
 * Verifies ownership before updating.
 */
async function update(userId: string, data: UpdateRecipeInput) {
  // Verify ownership
  const recipe = await RecipeRepository.findByIdAndUserId(data.id, userId);

  if (!recipe) {
    throw new Error("Recipe not found or not authorized");
  }

  const { id, ...updates } = data;
  await RecipeRepository.update(id, userId, updates);
  return { success: true };
}

/**
 * Delete a recipe.
 * Verifies ownership before deleting.
 */
async function deleteRecipe(userId: string, id: string) {
  // Verify ownership
  const recipe = await RecipeRepository.findByIdAndUserId(id, userId);

  if (!recipe) {
    throw new Error("Recipe not found or not authorized");
  }

  await RecipeRepository.delete(id, userId);
  return { success: true };
}

export const RecipeService = {
  getAll,
  create,
  update,
  delete: deleteRecipe,
} as const;
