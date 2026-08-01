import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addActiveRecipe,
  getAllActiveRecipes,
  removeActiveRecipe,
} from "@/serverFunctions/chats";
import type { ActiveRecipeInput } from "@/types/schemas/chats";

export const chatActiveRecipesKey = ["chatActiveRecipes"] as const;

export function useChatActiveRecipes() {
  return useQuery({
    queryKey: chatActiveRecipesKey,
    queryFn: () => getAllActiveRecipes(),
  });
}

export function useChatActiveRecipeMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: chatActiveRecipesKey });

  return {
    add: useMutation({
      mutationFn: (data: ActiveRecipeInput) => addActiveRecipe({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: ActiveRecipeInput) => removeActiveRecipe({ data }),
      onSuccess: invalidate,
    }),
  };
}
