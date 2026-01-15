import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllActiveRecipes,
  addActiveRecipe,
  removeActiveRecipe,
} from "@/serverFunctions/chats";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/cloudflare";
import type { ChatActiveRecipe } from "@/db/schema";

export const chatActiveRecipesCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<ChatActiveRecipe, string>({
      queryKey: ["chatActiveRecipes"],
      queryFn: async () => {
        const result = await getAllActiveRecipes();
        return result;
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await addActiveRecipe({
            data: {
              chatId: mutation.modified.chatId,
              recipeId: mutation.modified.recipeId,
            },
          });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          const item = mutation.original;
          if (item) {
            await removeActiveRecipe({
              data: {
                chatId: item.chatId,
                recipeId: item.recipeId,
              },
            });
          }
        }
      },
    }),
  ),
);
