import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import { getChats, updateChat, deleteChat } from "@/serverFunctions/chats";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/cloudflare";
import type { Chat } from "@/db/schema";

/**
 * Chats collection for optimistic updates.
 *
 * Note: onInsert is NOT defined here because chat creation is handled by
 * createChatAction which calls the server function directly. This avoids
 * double server calls when the action triggers a refetch.
 *
 * onUpdate and onDelete are handled here since they can be triggered by
 * direct collection.update()/delete() calls (e.g., from Sidebar rename/delete).
 */
export const chatsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<Chat, string>({
      queryKey: ["chats"],
      queryFn: async () => {
        const result = await getChats();
        return result;
      },
      queryClient,
      getKey: (item) => item.id,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await updateChat({
            data: {
              id: mutation.modified.id,
              title: mutation.modified.title,
            },
          });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await deleteChat({ data: { id: mutation.key as string } });
        }
      },
    }),
  ),
);
