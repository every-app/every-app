import { Save, X } from "lucide-react";
import type { Recipe } from "@/db/schema";

interface RecipeEditorProps {
  recipe: Recipe;
  editContent: string;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function RecipeEditor({
  recipe,
  editContent,
  onContentChange,
  onSave,
  onCancel,
}: RecipeEditorProps) {
  return (
    <div className="page-container h-full overflow-y-auto pt-6">
      {/* Back button */}
      <button
        onClick={onCancel}
        className="flex items-center gap-1 text-base-content/70 hover:text-base-content mb-4 transition-colors"
      >
        <X size={18} />
        <span className="text-sm">Cancel</span>
      </button>

      {/* Editor Card */}
      <div className="program-card">
        {/* Header with save button */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl font-bold text-base-content">Edit Recipe</h1>
            <p className="text-base-content/70 mt-1">{recipe.title}</p>
          </div>
          <button onClick={onSave} className="btn btn-primary btn-sm gap-1">
            <Save size={16} />
            <span>Save</span>
          </button>
        </div>

        {/* Editor */}
        <div className="border-t border-base-200 pt-4 -mx-5 px-5">
          <textarea
            value={editContent}
            onChange={(e) => onContentChange(e.target.value)}
            className="textarea textarea-bordered w-full min-h-[400px] font-mono text-sm"
            placeholder="Write your recipe in markdown..."
          />
        </div>
      </div>
    </div>
  );
}
