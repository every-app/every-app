import { useState } from "react";
import { Eye, ChefHat, Check } from "lucide-react";
import type { Recipe } from "@/db/schema";
import type { PromptUserWithRecipeUpdateInput } from "@/server/tools/recipeTools";
import { RecipeActionButtons, type RecipeAction } from "./RecipeActionButtons";
import { RecipePreviewModal } from "./RecipePreviewModal";

interface RecipeUpdatePromptProps {
  toolCallId: string;
  input: PromptUserWithRecipeUpdateInput;
  activeRecipes: Recipe[];
  onAction: (action: RecipeAction, recipeId?: string) => void;
  isCompleted?: boolean;
  completedAction?: RecipeAction;
  completedRecipeId?: string;
}

// Helper to normalize titles for comparison
function normalizeTitle(title: string): string {
  return title.toLowerCase().trim();
}

export function RecipeUpdatePrompt({
  input,
  activeRecipes,
  onAction,
  isCompleted = false,
  completedAction,
  completedRecipeId,
}: RecipeUpdatePromptProps) {
  const [showPreview, setShowPreview] = useState(false);

  // Check if there's a matching active recipe by title
  const matchingRecipe = activeRecipes.find(
    (recipe) => normalizeTitle(recipe.title) === normalizeTitle(input.title),
  );

  // If completed, show the result
  if (isCompleted) {
    const completedRecipe = completedRecipeId
      ? activeRecipes.find((r) => r.id === completedRecipeId)
      : null;

    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <ChefHat size={18} className="text-primary" />
          <span className="font-medium">{input.title}</span>
        </div>

        <div className="flex items-center gap-2 text-sm text-success">
          <Check size={16} />
          {completedAction === "create" && <span>Recipe created!</span>}
          {completedAction === "update" && (
            <span>
              Updated &quot;{completedRecipe?.title || "recipe"}&quot;
            </span>
          )}
          {completedAction === "ignore" && (
            <span className="text-base-content/60">
              Recipe suggestion dismissed
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ChefHat size={18} className="text-primary" />
            <span className="font-medium">{input.title}</span>
          </div>
          <button
            onClick={() => setShowPreview(true)}
            className="btn btn-ghost btn-xs gap-1"
          >
            <Eye size={14} />
            Preview
          </button>
        </div>

        <p className="text-sm text-base-content/70 mb-4">
          Would you like to save this recipe?
        </p>

        <div className="flex flex-wrap gap-2">
          <RecipeActionButtons
            activeRecipes={activeRecipes}
            matchingRecipe={matchingRecipe}
            onAction={onAction}
          />
        </div>
      </div>

      {/* Recipe Preview Modal */}
      {showPreview && (
        <RecipePreviewModal
          title={input.title}
          content={input.content}
          activeRecipes={activeRecipes}
          matchingRecipe={matchingRecipe}
          onAction={onAction}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
}
