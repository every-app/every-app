import { X } from "lucide-react";
import type { Recipe } from "@/db/schema";
import { MarkdownRenderer } from "../MarkdownRenderer";

interface RecipeModalProps {
  recipe: Recipe;
  isOpen: boolean;
  onClose: () => void;
  onRemove: () => void;
}

export function RecipeModal({
  recipe,
  isOpen,
  onClose,
  onRemove,
}: RecipeModalProps) {
  if (!isOpen) return null;

  const handleRemove = () => {
    onRemove();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-base-100">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-base-300 bg-base-100">
        <h2 className="font-bold text-lg text-base-content">{recipe.title}</h2>
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
          <MarkdownRenderer content={recipe.content} />
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-base-300 p-4 bg-base-100">
        <div className="max-w-2xl mx-auto flex gap-3">
          <button onClick={onClose} className="btn btn-primary flex-1">
            Back to Chat
          </button>
          <button onClick={handleRemove} className="btn btn-ghost">
            Done Cooking
          </button>
        </div>
      </div>
    </div>
  );
}
