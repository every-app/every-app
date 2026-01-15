import { z } from "zod";

// Define schema for UIMessage validation
const uiMessagePartSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const uiMessageSchema = z
  .object({
    id: z.string().min(1, "Message ID is required"),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(uiMessagePartSchema).min(1, "At least one part is required"),
  })
  .passthrough();

export const chatRequestSchema = z.object({
  chatId: z
    .string()
    .min(1, "Chat ID is required")
    .uuid("Invalid chat ID format"),
  message: uiMessageSchema,
});

export const imageRequestSchema = z.object({
  key: z.string().min(1, "Image key is required"),
});
