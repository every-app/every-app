import { X, BookOpen } from "lucide-react";
import type { Recipe } from "@/db/schema";

interface ActiveRecipeCardProps {
  recipe: Recipe;
  onOpen: () => void;
  onRemove: () => void;
}

export function ActiveRecipeCard({
  recipe,
  onOpen,
  onRemove,
}: ActiveRecipeCardProps) {
  return (
    <div className="recipe-card">
      <div className="recipe-card-header" onClick={onOpen}>
        <div className="flex items-center gap-2">
          <BookOpen size={18} className="text-primary" />
          <span className="font-medium text-sm">{recipe.title}</span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="btn btn-ghost btn-xs btn-circle"
          aria-label="Remove recipe"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
