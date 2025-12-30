import type { Recipe } from "@/db/schema";
import { useDialogControl } from "@/client/hooks/useDialogControl";
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
  const dialogRef = useDialogControl(isOpen);

  const handleRemove = () => {
    onRemove();
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
      onClose={onClose}
    >
      <div className="modal-box h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[calc(100vh-5em)] flex flex-col rounded-none sm:rounded-box">
        <h3 className="font-bold text-lg mb-4">{recipe.title}</h3>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-2xl mx-auto">
            <MarkdownRenderer content={recipe.content} />
          </div>
        </div>

        {/* Footer */}
        <div className="modal-action flex-col gap-2 mt-auto">
          <button onClick={onClose} className="btn btn-primary w-full">
            Back to Chat
          </button>
          <button onClick={handleRemove} className="btn btn-ghost w-full">
            Done Cooking
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
