import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/tanstack";
import { RecipeService } from "@/server/services/RecipeService";
import {
  createRecipeSchema,
  updateRecipeSchema,
  deleteRecipeSchema,
} from "@/types/schemas/recipes";

// Get all recipes for user
export const getAllRecipes = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return RecipeService.getAll(context.userId);
  });

// Create a new recipe
export const createRecipe = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createRecipeSchema.parse(data))
  .handler(async ({ data, context }) => {
    return RecipeService.create(context.userId, data);
  });

// Update a recipe
export const updateRecipe = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateRecipeSchema.parse(data))
  .handler(async ({ data, context }) => {
    return RecipeService.update(context.userId, data);
  });

// Delete a recipe
export const deleteRecipe = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => deleteRecipeSchema.parse(data))
  .handler(async ({ data, context }) => {
    return RecipeService.delete(context.userId, data.id);
  });
