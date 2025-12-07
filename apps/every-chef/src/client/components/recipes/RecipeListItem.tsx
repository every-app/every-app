import type { Recipe } from "@/db/schema";
import { Link } from "@tanstack/react-router";
import { Trash2, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { recipesCollection } from "@/client/tanstack-db";

interface RecipeListItemProps {
  recipe: Recipe;
  isEditMode?: boolean;
}

export function RecipeListItem({
  recipe,
  isEditMode = false,
}: RecipeListItemProps) {
  // Count ingredients (lines starting with -)
  const getIngredientCount = (content: string): number => {
    return content.split("\n").filter((line) => line.trim().startsWith("-"))
      .length;
  };

  // Count steps (numbered lines)
  const getStepCount = (content: string): number => {
    return content.split("\n").filter((line) => line.trim().match(/^\d+\./))
      .length;
  };

  const ingredientCount = getIngredientCount(recipe.content);
  const stepCount = getStepCount(recipe.content);

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    recipesCollection.delete(recipe.id);
    toast("Recipe deleted");
  };

  // Build metadata string
  const metadata = [
    ingredientCount > 0 ? `${ingredientCount} ingredients` : null,
    stepCount > 0 ? `${stepCount} steps` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const rowContent = (
    <div className="flex items-center gap-3 py-3 group">
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-base-content truncate">
          {recipe.title}
        </h3>
        {metadata && (
          <p className="text-sm text-base-content/50 mt-0.5">{metadata}</p>
        )}
      </div>
      <ChevronRight className="h-4 w-4 text-base-content/30 flex-shrink-0 group-hover:text-base-content/50 transition-colors" />
    </div>
  );

  if (isEditMode) {
    return (
      <div className="flex items-center gap-2 px-4">
        <button
          onClick={handleDelete}
          className="btn btn-ghost btn-sm btn-circle text-error hover:bg-error/10 flex-shrink-0"
          aria-label="Delete recipe"
        >
          <Trash2 size={18} />
        </button>
        <Link
          to="/recipes/$recipeId"
          params={{ recipeId: recipe.id }}
          className="flex-1 min-w-0"
        >
          {rowContent}
        </Link>
      </div>
    );
  }

  return (
    <Link
      to="/recipes/$recipeId"
      params={{ recipeId: recipe.id }}
      className="block px-4 hover:bg-base-200/50 transition-colors"
    >
      {rowContent}
    </Link>
  );
}
