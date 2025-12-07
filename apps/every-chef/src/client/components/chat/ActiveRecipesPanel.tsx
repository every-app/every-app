import { useState } from "react";
import type { Recipe } from "@/db/schema";
import { ActiveRecipeCard } from "./ActiveRecipeCard";
import { RecipeModal } from "./RecipeModal";

interface ActiveRecipesPanelProps {
  recipes: Recipe[];
  onRemoveRecipe: (recipeId: string) => void;
}

export function ActiveRecipesPanel({
  recipes,
  onRemoveRecipe,
}: ActiveRecipesPanelProps) {
  const [openRecipeId, setOpenRecipeId] = useState<string | null>(null);

  if (recipes.length === 0) {
    return null;
  }

  const openRecipe = openRecipeId
    ? recipes.find((r) => r.id === openRecipeId)
    : null;

  return (
    <>
      <div className="flex-shrink-0 p-3">
        <div className="max-w-2xl mx-auto space-y-2">
          {recipes.map((recipe) => (
            <ActiveRecipeCard
              key={recipe.id}
              recipe={recipe}
              onOpen={() => setOpenRecipeId(recipe.id)}
              onRemove={() => onRemoveRecipe(recipe.id)}
            />
          ))}
        </div>
      </div>

      {/* Recipe Modal */}
      {openRecipe && (
        <RecipeModal
          recipe={openRecipe}
          isOpen={!!openRecipeId}
          onClose={() => setOpenRecipeId(null)}
          onRemove={() => onRemoveRecipe(openRecipe.id)}
        />
      )}
    </>
  );
}
