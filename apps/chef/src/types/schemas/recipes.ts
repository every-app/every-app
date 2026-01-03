import { z } from "zod";

// === Create Recipe ===
export const createRecipeSchema = z.object({
  id: z.string().uuid("Invalid recipe ID format"),
  title: z.string().min(1),
  content: z.string(),
});

export type CreateRecipeInput = z.infer<typeof createRecipeSchema>;

// === Update Recipe ===
export const updateRecipeSchema = z.object({
  id: z.string().uuid("Invalid recipe ID format"),
  title: z.string().min(1).optional(),
  content: z.string().optional(),
});

export type UpdateRecipeInput = z.infer<typeof updateRecipeSchema>;

// === Delete Recipe ===
export const deleteRecipeSchema = z.object({
  id: z.string().uuid("Invalid recipe ID format"),
});
