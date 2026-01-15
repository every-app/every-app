import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllRecipes,
  createRecipe,
  updateRecipe,
  deleteRecipe,
} from "@/serverFunctions/recipes";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/cloudflare";
import type { Recipe } from "@/db/schema";

export const recipesCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<Recipe, string>({
      queryKey: ["recipes"],
      queryFn: async () => {
        const result = await getAllRecipes();
        return result.recipes;
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await createRecipe({
            data: {
              id: mutation.modified.id,
              title: mutation.modified.title,
              content: mutation.modified.content,
            },
          });
        }
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await updateRecipe({
            data: {
              id: mutation.modified.id,
              title: mutation.modified.title,
              content: mutation.modified.content,
            },
          });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await deleteRecipe({ data: { id: mutation.key as string } });
        }
      },
    }),
  ),
);
