import { X, ChefHat } from "lucide-react";
import type { Recipe } from "@/db/schema";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { RecipeActionButtons, type RecipeAction } from "./RecipeActionButtons";

interface RecipePreviewModalProps {
  title: string;
  content: string;
  activeRecipes: Recipe[];
  matchingRecipe: Recipe | undefined;
  onAction: (action: RecipeAction, recipeId?: string) => void;
  onClose: () => void;
}

export function RecipePreviewModal({
  title,
  content,
  activeRecipes,
  matchingRecipe,
  onAction,
  onClose,
}: RecipePreviewModalProps) {
  const handleAction = (action: RecipeAction, recipeId?: string) => {
    onClose();
    onAction(action, recipeId);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-base-100">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-base-300 bg-base-100">
        <div className="flex items-center gap-2">
          <ChefHat size={20} className="text-primary" />
          <h2 className="font-bold text-lg text-base-content">{title}</h2>
        </div>
        <button
          onClick={onClose}
          className="btn btn-ghost btn-sm btn-circle"
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto">
          <MarkdownRenderer content={content} />
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-base-300 p-4 bg-base-100">
        <div className="max-w-2xl mx-auto flex flex-wrap gap-3">
          <RecipeActionButtons
            activeRecipes={activeRecipes}
            matchingRecipe={matchingRecipe}
            onAction={handleAction}
            fullWidth
          />
        </div>
      </div>
    </div>
  );
}
