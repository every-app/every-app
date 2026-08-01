import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { recipes } from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import {
  createRecipeSchema,
  updateRecipeSchema,
  deleteRecipeSchema,
} from "@/types/schemas/recipes";

export const getAllRecipes = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const userRecipes = await db.query.recipes.findMany({
      where: eq(recipes.userId, context.userId),
      orderBy: (recipes, { desc }) => [desc(recipes.updatedAt)],
    });

    return { recipes: userRecipes };
  });

export const createRecipe = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => createRecipeSchema.parse(data))
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();

    await db.insert(recipes).values({
      id: data.id,
      userId: context.userId,
      title: data.title,
      content: data.content,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true };
  });

export const updateRecipe = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => updateRecipeSchema.parse(data))
  .handler(async ({ data, context }) => {
    const existingRecipe = await db.query.recipes.findFirst({
      where: and(eq(recipes.id, data.id), eq(recipes.userId, context.userId)),
    });

    if (!existingRecipe) {
      throw new Error("Recipe not found or not authorized");
    }

    await db
      .update(recipes)
      .set({
        title: data.title ?? existingRecipe.title,
        content: data.content ?? existingRecipe.content,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(recipes.id, data.id), eq(recipes.userId, context.userId)));

    return { success: true };
  });

export const deleteRecipe = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => deleteRecipeSchema.parse(data))
  .handler(async ({ data, context }) => {
    const existingRecipe = await db.query.recipes.findFirst({
      where: and(eq(recipes.id, data.id), eq(recipes.userId, context.userId)),
    });

    if (!existingRecipe) {
      throw new Error("Recipe not found or not authorized");
    }

    await db
      .delete(recipes)
      .where(and(eq(recipes.id, data.id), eq(recipes.userId, context.userId)));

    return { success: true };
  });
