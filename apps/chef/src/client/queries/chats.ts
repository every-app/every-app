import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createChat,
  deleteChat,
  getChats,
  startCookingWithRecipe,
  updateChat,
} from "@/serverFunctions/chats";
import type {
  CreateChatInput,
  DeleteChatInput,
  StartCookingInput,
  UpdateChatInput,
} from "@/types/schemas/chats";
import { chatActiveRecipesKey } from "./chatActiveRecipes";

const chatsKey = ["chats"] as const;

export function useChats() {
  return useQuery({
    queryKey: chatsKey,
    queryFn: () => getChats(),
  });
}

export function useChatMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: chatsKey });

  return {
    create: useMutation({
      mutationFn: (data: CreateChatInput) => createChat({ data }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (data: UpdateChatInput) => updateChat({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: DeleteChatInput) => deleteChat({ data }),
      onSuccess: invalidate,
    }),
    startCooking: useMutation({
      mutationFn: (data: StartCookingInput) => startCookingWithRecipe({ data }),
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: chatsKey }),
          queryClient.invalidateQueries({ queryKey: chatActiveRecipesKey }),
        ]),
    }),
  };
}
