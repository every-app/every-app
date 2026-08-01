import { z } from "zod";
import { DATE_KEY_REGEX, isValidDateKey } from "@/lib/date-key";

const dueDateSchema = z
  .string()
  .regex(DATE_KEY_REGEX, "Due date must be in YYYY-MM-DD format")
  .refine(isValidDateKey, "Due date must be a valid calendar date");

export const createTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
  title: z.string().min(1, "Title is required").max(1024, "Title too long"),
  sortKey: z.string(),
  dueDate: dueDateSchema.nullable().optional(),
});

export const updateTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
  title: z
    .string()
    .min(1, "Title is required")
    .max(1024, "Title too long")
    .optional(),
  completed: z.boolean().optional(),
  sortKey: z.string().optional(),
  dueDate: dueDateSchema.nullable().optional(),
});

export const deleteTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
});

export type CreateTodoInput = z.infer<typeof createTodoSchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;
export type DeleteTodoInput = z.infer<typeof deleteTodoSchema>;
