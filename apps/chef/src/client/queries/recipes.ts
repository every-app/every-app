import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRecipe,
  deleteRecipe,
  getAllRecipes,
  updateRecipe,
} from "@/serverFunctions/recipes";
import type {
  CreateRecipeInput,
  DeleteRecipeInput,
  UpdateRecipeInput,
} from "@/types/schemas/recipes";

const recipesKey = ["recipes"] as const;

export function useRecipes() {
  return useQuery({
    queryKey: recipesKey,
    queryFn: async () => (await getAllRecipes()).recipes,
  });
}

export function useRecipeMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: recipesKey });

  return {
    create: useMutation({
      mutationFn: (data: CreateRecipeInput) => createRecipe({ data }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (data: UpdateRecipeInput) => updateRecipe({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: DeleteRecipeInput) => deleteRecipe({ data }),
      onSuccess: invalidate,
    }),
  };
}
