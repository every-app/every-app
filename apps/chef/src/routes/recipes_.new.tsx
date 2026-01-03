import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { RecipeCreationForm } from "@/client/components/recipes/RecipeCreationForm";
import { recipesCollection } from "@/client/tanstack-db";

export const Route = createFileRoute("/recipes_/new")({
  component: NewRecipePage,
});

function NewRecipePage() {
  const navigate = useNavigate();

  const handleCancel = () => {
    navigate({ to: "/recipes", search: {} });
  };

  const handleSubmit = (data: { title: string; content: string }) => {
    const now = new Date().toISOString();
    const newRecipe = {
      id: crypto.randomUUID(),
      userId: "", // Will be set by the server
      title: data.title,
      content: data.content,
      createdAt: now,
      updatedAt: now,
    };

    recipesCollection.insert(newRecipe);
    toast("Recipe saved");
    navigate({ to: "/recipes", search: {} });
  };

  return <RecipeCreationForm onCancel={handleCancel} onSubmit={handleSubmit} />;
}
