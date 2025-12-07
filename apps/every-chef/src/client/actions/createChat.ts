import { createOptimisticAction } from "@tanstack/react-db";
import { chatsCollection } from "@/client/tanstack-db";
import { createChat } from "@/serverFunctions/chats";

type CreateChatParams = {
  chatId: string;
  title: string;
};

/**
 * Action to create a new chat.
 * Uses client-generated UUID for optimistic updates.
 *
 * The action can be awaited when you need to ensure the chat exists on the
 * server before performing follow-up actions (e.g., sending a message).
 */
export const createChatAction = createOptimisticAction<CreateChatParams>({
  onMutate: ({ chatId, title }) => {
    const now = new Date().toISOString();

    chatsCollection.insert({
      id: chatId,
      userId: "", // Will be set by server
      title,
      createdAt: now,
      updatedAt: now,
    });
  },
  mutationFn: async ({ chatId, title }) => {
    await createChat({
      data: {
        id: chatId,
        title,
      },
    });

    // Refetch to sync optimistic state with server
    await chatsCollection.utils.refetch();
  },
});
