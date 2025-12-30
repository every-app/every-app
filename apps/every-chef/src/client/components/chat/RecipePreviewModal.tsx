import { ChefHat } from "lucide-react";
import { useDialogControl } from "@/client/hooks/useDialogControl";
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
  isOpen?: boolean;
}

export function RecipePreviewModal({
  title,
  content,
  activeRecipes,
  matchingRecipe,
  onAction,
  onClose,
  isOpen = true,
}: RecipePreviewModalProps) {
  const dialogRef = useDialogControl(isOpen);

  const handleAction = (action: RecipeAction, recipeId?: string) => {
    onClose();
    onAction(action, recipeId);
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
      onClose={onClose}
    >
      <div className="modal-box h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[calc(100vh-5em)] flex flex-col rounded-none sm:rounded-box">
        <div className="flex items-center gap-2 mb-4">
          <ChefHat size={20} className="text-primary" />
          <h3 className="font-bold text-lg">{title}</h3>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-2xl mx-auto">
            <MarkdownRenderer content={content} />
          </div>
        </div>

        {/* Footer */}
        <div className="modal-action flex-col gap-2 mt-auto">
          <RecipeActionButtons
            activeRecipes={activeRecipes}
            matchingRecipe={matchingRecipe}
            onAction={handleAction}
            fullWidth
          />
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
