import { Link } from "@tanstack/react-router";

export function RecipeNotFound() {
  return (
    <div className="page-container">
      <div className="px-4 pt-6 pb-24">
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold mb-2">Recipe Not Found</h2>
          <p className="text-base-content/70 mb-4">
            The recipe you're looking for doesn't exist.
          </p>
          <Link to="/recipes" search={{}} className="btn btn-primary">
            Back to Recipes
          </Link>
        </div>
      </div>
    </div>
  );
}
