import { z } from "zod";

// === Create Todo ===
export const createTodoSchema = z.object({
  id: z.string().length(36), // expect uuid
  title: z.string().min(1, "Title is required").max(255, "Title too long"),
});

export type CreateTodoInput = z.infer<typeof createTodoSchema>;

// === Update Todo ===
export const updateTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
  title: z
    .string()
    .min(1, "Title is required")
    .max(255, "Title too long")
    .optional(),
  completed: z.boolean().optional(),
});

export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;

// === Delete Todo ===
export const deleteTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
});

export type DeleteTodoInput = z.infer<typeof deleteTodoSchema>;
