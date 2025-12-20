import { createServerFn } from "@tanstack/react-start";
import { chats } from "@/db/schema";
import { db } from "@/db";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { eq, desc, and } from "drizzle-orm";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/client";
import type { Chat } from "@/types";
import { z } from "zod";
import { MessageService } from "@/server/services/MessageService";

interface ServerContext {
  userId: string;
  userEmail: string;
}

// Zod schemas for input validation
const createChatSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(255),
});

const updateChatSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(255),
});

const deleteChatSchema = z.object({
  id: z.string().uuid(),
});

const getMessagesSchema = z.object({
  chatId: z.string().uuid(),
});

export const getChats = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: ServerContext }) => {
    const userChats = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, context.userId))
      .orderBy(desc(chats.updatedAt));

    return userChats;
  });

export const createChat = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(createChatSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof createChatSchema>;
      context: ServerContext;
    }) => {
      const newChat: Chat = {
        id: data.id,
        userId: context.userId,
        title: data.title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.insert(chats).values(newChat);

      return newChat;
    },
  );

export const updateChat = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(updateChatSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof updateChatSchema>;
      context: ServerContext;
    }) => {
      const updatedAt = new Date().toISOString();

      const result = await db
        .update(chats)
        .set({ title: data.title, updatedAt })
        .where(and(eq(chats.id, data.id), eq(chats.userId, context.userId)))
        .returning();

      if (result.length === 0) {
        throw new Error("Chat not found or unauthorized");
      }

      return result[0];
    },
  );

export const deleteChat = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(deleteChatSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof deleteChatSchema>;
      context: ServerContext;
    }) => {
      const result = await db
        .delete(chats)
        .where(and(eq(chats.id, data.id), eq(chats.userId, context.userId)))
        .returning();

      if (result.length === 0) {
        throw new Error("Chat not found or unauthorized");
      }

      return { success: true };
    },
  );

export const getMessages = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator(getMessagesSchema)
  .handler(
    async ({
      data,
      context,
    }: {
      data: z.infer<typeof getMessagesSchema>;
      context: ServerContext;
    }) => {
      // Use service to get messages with proper auth checks
      const normalizedMessages = await MessageService.getMessagesForChat(
        data.chatId,
        context.userId,
      );

      // Convert to UI format and return as plain objects
      return normalizedMessages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        parts: msg.content,
      }));
    },
  );
