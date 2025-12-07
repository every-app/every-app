import { Link } from "@tanstack/react-router";
import { ArrowLeft, Edit, ChefHat } from "lucide-react";
import { MarkdownRenderer } from "@/client/components/MarkdownRenderer";
import type { Recipe } from "@/db/schema";

interface RecipeDetailProps {
  recipe: Recipe;
  onEdit: () => void;
  onCook: () => void;
  isCookingLoading?: boolean;
}

export function RecipeDetail({
  recipe,
  onEdit,
  onCook,
  isCookingLoading = false,
}: RecipeDetailProps) {
  return (
    <div className="page-container h-full overflow-y-auto pt-6">
      {/* Back Link */}
      <Link
        to="/recipes"
        search={{}}
        className="flex items-center gap-1 text-base-content/70 hover:text-base-content mb-4 transition-colors"
      >
        <ArrowLeft size={18} />
        <span className="text-sm">Back to Recipes</span>
      </Link>

      {/* Recipe Card */}
      <div className="program-card">
        {/* Header with actions */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <h1 className="text-xl font-bold text-base-content">
            {recipe.title}
          </h1>
          <div className="flex gap-2 shrink-0">
            <button onClick={onEdit} className="btn btn-ghost btn-sm gap-1">
              <Edit size={16} />
              <span>Edit</span>
            </button>
            <button
              onClick={onCook}
              disabled={isCookingLoading}
              className="btn btn-primary btn-sm gap-1"
            >
              {isCookingLoading ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : (
                <ChefHat size={16} />
              )}
              <span>{isCookingLoading ? "Starting..." : "Cook"}</span>
            </button>
          </div>
        </div>

        {/* Recipe Content */}
        <div className="border-t border-base-200 pt-4 -mx-5 px-5">
          <MarkdownRenderer content={recipe.content} />
        </div>
      </div>
    </div>
  );
}
