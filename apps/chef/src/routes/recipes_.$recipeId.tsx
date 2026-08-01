import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { RecipeNotFound } from "@/client/components/recipes/RecipeNotFound";
import { RecipeEditor } from "@/client/components/recipes/RecipeEditor";
import { RecipeDetail } from "@/client/components/recipes/RecipeDetail";
import { useRecipes, useRecipeMutations } from "@/client/queries/recipes";
import { useChats, useChatMutations } from "@/client/queries/chats";
import { useChatActiveRecipes } from "@/client/queries/chatActiveRecipes";
import type { StartCookingInput } from "@/types/schemas/chats";
import { toast } from "sonner";

export const Route = createFileRoute("/recipes_/$recipeId")({
  component: RecipeDetailPage,
});

function RecipeDetailPage() {
  const { recipeId } = Route.useParams();
  const navigate = useNavigate();

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [isCookingLoading, setIsCookingLoading] = useState(false);

  const { data: recipes } = useRecipes();
  const { data: chats } = useChats();
  const { data: activeRecipes } = useChatActiveRecipes();
  const { mutateAsync: updateRecipe } = useRecipeMutations().update;
  const { mutateAsync: startCooking } = useChatMutations().startCooking;

  const recipe = (recipes ?? []).find((r) => r.id === recipeId);

  const handleEdit = () => {
    if (recipe) {
      setEditContent(recipe.content);
      setIsEditing(true);
    }
  };

  const handleSaveEdit = async () => {
    if (recipe) {
      await updateRecipe({
        id: recipe.id,
        content: editContent,
      });
      toast("Changes saved");
      setIsEditing(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent("");
  };

  const handleCook = async () => {
    if (!recipe) return;

    setIsCookingLoading(true);
    try {
      // Find active cooking chat (recent chat with active recipes)
      const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
      const sortedChats = [...(chats ?? [])].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      const mostRecentChat = sortedChats[0];
      const isRecentWithActiveRecipes =
        mostRecentChat &&
        Date.now() - new Date(mostRecentChat.updatedAt).getTime() <
          THREE_HOURS_MS &&
        (activeRecipes ?? []).some((ar) => ar.chatId === mostRecentChat.id);

      const existingChatId = isRecentWithActiveRecipes
        ? mostRecentChat.id
        : null;

      const params: StartCookingInput = {
        chatId: existingChatId ?? crypto.randomUUID(),
        chatTitle: `Cooking: ${recipe.title}`,
        activeRecipeId: crypto.randomUUID(),
        recipeId: recipe.id,
        isNewChat: !existingChatId,
      };

      await startCooking(params);
      navigate({ to: "/chat/$chatId", params: { chatId: params.chatId } });
    } catch (error) {
      console.error("Failed to start cooking:", error);
      toast.error("Failed to start cooking. Please try again.");
    } finally {
      setIsCookingLoading(false);
    }
  };

  const renderContent = () => {
    if (!recipe) {
      return <RecipeNotFound />;
    }

    if (isEditing) {
      return (
        <RecipeEditor
          recipe={recipe}
          editContent={editContent}
          onContentChange={setEditContent}
          onSave={handleSaveEdit}
          onCancel={handleCancelEdit}
        />
      );
    }

    return (
      <RecipeDetail
        recipe={recipe}
        onEdit={handleEdit}
        onCook={handleCook}
        isCookingLoading={isCookingLoading}
      />
    );
  };

  return renderContent();
}
