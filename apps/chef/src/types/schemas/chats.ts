import { z } from "zod";

export const createChatSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(255),
});
export type CreateChatInput = z.infer<typeof createChatSchema>;

export const updateChatSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(255),
});
export type UpdateChatInput = z.infer<typeof updateChatSchema>;

export const deleteChatSchema = z.object({
  id: z.string().uuid(),
});
export type DeleteChatInput = z.infer<typeof deleteChatSchema>;

export const getMessagesSchema = z.object({
  chatId: z.string().uuid(),
});

export const activeRecipeSchema = z.object({
  chatId: z.string().uuid(),
  recipeId: z.string().uuid(),
});
export type ActiveRecipeInput = z.infer<typeof activeRecipeSchema>;

export const saveToolOutputSchema = z.object({
  toolCallId: z.string(),
  output: z.record(z.string(), z.unknown()),
});

export const startCookingSchema = z.object({
  chatId: z.string().uuid(),
  chatTitle: z.string().min(1).max(255),
  activeRecipeId: z.string().uuid(),
  recipeId: z.string().uuid(),
  isNewChat: z.boolean(),
});
export type StartCookingInput = z.infer<typeof startCookingSchema>;
