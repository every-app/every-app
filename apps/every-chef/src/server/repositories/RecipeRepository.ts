import { db } from "@/db";
import { recipes } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// Types for repository operations
type CreateRecipe = {
  id: string;
  userId: string;
  title: string;
  content: string;
};

type UpdateRecipe = {
  title?: string;
  content?: string;
};

/**
 * Find all recipes for a user.
 */
async function findAllByUserId(userId: string) {
  return db.query.recipes.findMany({
    where: eq(recipes.userId, userId),
    orderBy: (recipes, { desc }) => [desc(recipes.updatedAt)],
  });
}

/**
 * Find a recipe by ID and verify ownership.
 */
async function findByIdAndUserId(id: string, userId: string) {
  return db.query.recipes.findFirst({
    where: and(eq(recipes.id, id), eq(recipes.userId, userId)),
  });
}

/**
 * Create a new recipe.
 */
async function create(data: CreateRecipe) {
  const now = new Date().toISOString();

  await db.insert(recipes).values({
    id: data.id,
    userId: data.userId,
    title: data.title,
    content: data.content,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Update a recipe.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function update(id: string, userId: string, data: UpdateRecipe) {
  await db
    .update(recipes)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(recipes.id, id), eq(recipes.userId, userId)));
}

/**
 * Delete a recipe.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function deleteById(id: string, userId: string) {
  await db
    .delete(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.userId, userId)));
}

export const RecipeRepository = {
  findAllByUserId,
  findByIdAndUserId,
  create,
  update,
  delete: deleteById,
} as const;
