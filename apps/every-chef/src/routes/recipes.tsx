import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RecipeListItem } from "@/client/components/recipes/RecipeListItem";
import { EmptyState } from "@/client/components/ui/empty-state";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { BookOpen, Plus, Pencil } from "lucide-react";
import { recipesCollection } from "@/client/tanstack-db";
import { useLiveQuery } from "@tanstack/react-db";

export const Route = createFileRoute("/recipes")({
  component: RecipesPage,
  validateSearch: (search: Record<string, unknown>): { edit?: boolean } => ({
    edit: search.edit === true || search.edit === "true" ? true : undefined,
  }),
});

function RecipesPage() {
  const { edit } = Route.useSearch();
  const isEditMode = edit === true;
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const toggleEditMode = () => {
    navigate({
      to: "/recipes",
      search: isEditMode ? {} : { edit: true },
      replace: true,
    });
  };

  // Get all recipes from TanstackDB
  const { data: recipes } = useLiveQuery((q) =>
    q.from({ recipe: recipesCollection }),
  );

  const recipeList = recipes ?? [];

  return (
    <div className="page-container overflow-auto h-full">
      <div className="py-6">
        {/* Recipes List */}
        {recipeList.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-12 w-12 mx-auto" />}
            title="No Recipes Yet"
            description="Ask the AI to help you create a recipe, then save it here."
          />
        ) : (
          <div className="bg-base-100 rounded-xl border border-base-300">
            {/* Card Header - only show on desktop */}
            {!isMobile && (
              <div className="px-4 py-4 border-b border-base-300">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-lg font-semibold text-base-content">
                      Recipes
                    </h1>
                    <p className="text-base-content/60 text-sm mt-0.5">
                      Your saved recipes and cooking favorites
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={toggleEditMode}
                      className={`btn btn-sm gap-1 ${isEditMode ? "btn-secondary" : "btn-ghost"}`}
                    >
                      <Pencil size={16} />
                      <span>{isEditMode ? "Done" : "Edit"}</span>
                    </button>
                    <Link
                      to="/recipes/new"
                      className="btn btn-primary btn-sm gap-1"
                    >
                      <Plus size={16} />
                      <span>New Recipe</span>
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {/* Recipe Items */}
            <div className="divide-y divide-base-300">
              {recipeList.map((recipe) => (
                <RecipeListItem
                  key={recipe.id}
                  recipe={recipe}
                  isEditMode={isEditMode}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
