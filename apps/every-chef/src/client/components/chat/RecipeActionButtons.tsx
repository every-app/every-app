import { useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import type { Recipe } from "@/db/schema";

export type RecipeAction = "create" | "update" | "ignore";

interface RecipeActionButtonsProps {
  activeRecipes: Recipe[];
  matchingRecipe: Recipe | undefined;
  onAction: (action: RecipeAction, recipeId?: string) => void;
  /** If true, uses full-width flex layout for modal footer */
  fullWidth?: boolean;
}

export function RecipeActionButtons({
  activeRecipes,
  matchingRecipe,
  onAction,
  fullWidth = false,
}: RecipeActionButtonsProps) {
  const [showUpdateDropdown, setShowUpdateDropdown] = useState(false);
  const isUpdatePrimary = !!matchingRecipe;

  const handleCreate = () => {
    onAction("create");
  };

  const handleUpdate = (recipeId: string) => {
    setShowUpdateDropdown(false);
    onAction("update", recipeId);
  };

  const handleIgnore = () => {
    onAction("ignore");
  };

  const primaryBtnClass = fullWidth
    ? "btn btn-primary flex-1 gap-1"
    : "btn btn-primary btn-sm gap-1";
  const secondaryBtnClass = fullWidth
    ? "btn btn-outline flex-1 gap-1"
    : "btn btn-outline btn-sm gap-1";
  const ghostBtnClass = fullWidth
    ? "btn btn-ghost"
    : "btn btn-ghost btn-sm gap-1";

  // If matching recipe exists, show Update as primary action
  if (isUpdatePrimary && matchingRecipe) {
    return (
      <>
        <button
          onClick={() => handleUpdate(matchingRecipe.id)}
          className={primaryBtnClass}
        >
          <RefreshCw size={16} />
          Update
        </button>

        <button onClick={handleCreate} className={secondaryBtnClass}>
          <Plus size={16} />
          Create New
        </button>

        <button onClick={handleIgnore} className={ghostBtnClass}>
          {!fullWidth && <X size={16} />}
          {fullWidth ? "Back" : "Ignore"}
        </button>
      </>
    );
  }

  // Default: Create New as primary
  return (
    <>
      <button onClick={handleCreate} className={primaryBtnClass}>
        <Plus size={16} />
        {fullWidth ? "Create New Recipe" : "Create New"}
      </button>

      {activeRecipes.length > 0 &&
        (fullWidth ? (
          <div className="dropdown dropdown-top flex-1">
            <div
              tabIndex={0}
              role="button"
              className="btn btn-outline w-full gap-1"
            >
              <RefreshCw size={16} />
              Update Existing
            </div>
            <ul
              tabIndex={0}
              className="dropdown-content menu bg-base-100 rounded-box z-10 w-full p-2 shadow border border-base-300 mb-2"
            >
              {activeRecipes.map((recipe) => (
                <li key={recipe.id}>
                  <button onClick={() => handleUpdate(recipe.id)}>
                    {recipe.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="relative">
            <button
              onClick={() => setShowUpdateDropdown(!showUpdateDropdown)}
              className={secondaryBtnClass}
            >
              <RefreshCw size={16} />
              Update Existing
            </button>

            {showUpdateDropdown && (
              <div className="absolute top-full left-0 mt-1 z-10 bg-base-100 border border-base-300 rounded-lg shadow-lg min-w-48">
                <div className="p-2">
                  <p className="text-xs text-base-content/60 px-2 pb-2">
                    Select a recipe to update:
                  </p>
                  {activeRecipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      onClick={() => handleUpdate(recipe.id)}
                      className="w-full text-left px-3 py-2 hover:bg-base-200 rounded text-sm"
                    >
                      {recipe.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

      <button onClick={handleIgnore} className={ghostBtnClass}>
        {!fullWidth && <X size={16} />}
        {fullWidth ? "Back" : "Ignore"}
      </button>
    </>
  );
}
