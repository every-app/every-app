import { createOptimisticAction } from "@tanstack/react-db";
import {
  chatsCollection,
  chatActiveRecipesCollection,
} from "@/client/tanstack-db";
import { startCookingWithRecipe } from "@/serverFunctions/chats";

export type StartCookingParams = {
  chatId: string;
  chatTitle: string;
  activeRecipeId: string;
  recipeId: string;
  isNewChat: boolean;
};

/**
 * Action to start cooking with a recipe.
 * Optionally creates a new chat and adds the recipe to the chat's active recipes.
 */
export const startCooking = createOptimisticAction<StartCookingParams>({
  onMutate: ({ chatId, chatTitle, activeRecipeId, recipeId, isNewChat }) => {
    const now = new Date().toISOString();

    // Optimistically insert the chat if it's new
    if (isNewChat) {
      chatsCollection.insert({
        id: chatId,
        userId: "", // Will be set by server
        title: chatTitle,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Optimistically insert the active recipe
    chatActiveRecipesCollection.insert({
      id: activeRecipeId,
      chatId,
      recipeId,
      activatedAt: now,
    });
  },
  mutationFn: async ({
    chatId,
    chatTitle,
    activeRecipeId,
    recipeId,
    isNewChat,
  }) => {
    await startCookingWithRecipe({
      data: {
        chatId,
        chatTitle,
        activeRecipeId,
        recipeId,
        isNewChat,
      },
    });

    // Refetch to sync optimistic state with server
    await Promise.all([
      chatsCollection.utils.refetch(),
      chatActiveRecipesCollection.utils.refetch(),
    ]);
  },
});
