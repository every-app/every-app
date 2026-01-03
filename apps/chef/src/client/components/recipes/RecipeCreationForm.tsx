import { useState } from "react";
import { ArrowLeft, Save } from "lucide-react";

interface RecipeCreationFormProps {
  onCancel: () => void;
  onSubmit: (data: { title: string; content: string }) => void;
}

export function RecipeCreationForm({
  onCancel,
  onSubmit,
}: RecipeCreationFormProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), content });
  };

  const isValid = title.trim().length > 0;

  return (
    <div className="page-container h-full overflow-y-auto pt-6">
      {/* Back button */}
      <button
        onClick={onCancel}
        className="flex items-center gap-1 text-base-content/70 hover:text-base-content mb-4 transition-colors"
      >
        <ArrowLeft size={18} />
        <span className="text-sm">Cancel</span>
      </button>

      {/* Form Card */}
      <form onSubmit={handleSubmit} className="program-card">
        {/* Header with save button */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl font-bold text-base-content">
              Create New Recipe
            </h1>
            <p className="text-base-content/70 mt-1">
              Add your own custom recipe
            </p>
          </div>
          <button
            type="submit"
            disabled={!isValid}
            className="btn btn-primary btn-sm gap-1"
          >
            <Save size={16} />
            <span>Save</span>
          </button>
        </div>

        {/* Title */}
        <div className="border-t border-base-200 pt-4 -mx-5 px-5">
          <input
            type="text"
            placeholder="Recipe title..."
            className="input input-bordered w-full mb-4"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />

          {/* Content */}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="textarea textarea-bordered w-full min-h-[400px] font-mono text-sm"
            placeholder="Write your recipe in markdown..."
          />
        </div>
      </form>
    </div>
  );
}
