import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { RecipeCreationForm } from "@/client/components/recipes/RecipeCreationForm";
import { useRecipeMutations } from "@/client/queries/recipes";

export const Route = createFileRoute("/recipes_/new")({
  component: NewRecipePage,
});

function NewRecipePage() {
  const navigate = useNavigate();
  const { mutate: createRecipe, isPending } = useRecipeMutations().create;

  const handleCancel = () => {
    navigate({ to: "/recipes", search: {} });
  };

  const handleSubmit = (data: { title: string; content: string }) => {
    if (isPending) return;
    createRecipe(
      {
        id: crypto.randomUUID(),
        title: data.title,
        content: data.content,
      },
      {
        onSuccess: () => {
          toast("Recipe saved");
          navigate({ to: "/recipes", search: {} });
        },
        onError: () => toast.error("Failed to save recipe"),
      },
    );
  };

  return (
    <RecipeCreationForm
      onCancel={handleCancel}
      onSubmit={handleSubmit}
      isSubmitting={isPending}
    />
  );
}
