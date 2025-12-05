import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getChats,
  createChat,
  updateChat,
  deleteChat,
} from "@/serverFunctions/chats";
import type { Chat } from "@/types";

export function useChatManagement() {
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: chats } = useQuery({
    queryKey: ["chats"],
    queryFn: () => getChats(),
  });

  // Auto-select first chat if none selected
  useEffect(() => {
    if (!selectedChatId && chats && chats.length > 0) {
      setSelectedChatId(chats[0].id);
    }
  }, [chats, selectedChatId]);

  const createChatMutation = useMutation({
    mutationFn: (data: { title: string }) => createChat({ data }),
    onMutate: async (data) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["chats"] });

      // Snapshot the previous value
      const previousChats = queryClient.getQueryData<Chat[]>(["chats"]);

      // Optimistically update to the new value
      const optimisticChat: Chat = {
        id: crypto.randomUUID(),
        userId: "", // Will be set by server
        title: data.title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<Chat[]>(["chats"], (old) => [
        optimisticChat,
        ...(old || []),
      ]);

      setSelectedChatId(optimisticChat.id);

      return { previousChats, optimisticChat };
    },
    onError: (_err, _variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousChats) {
        queryClient.setQueryData(["chats"], context.previousChats);
      }
      if (context?.previousChats && context.previousChats.length > 0) {
        setSelectedChatId(context.previousChats[0].id);
      } else {
        setSelectedChatId(null);
      }
    },
    onSuccess: (newChat, _variables, context) => {
      // Replace the optimistic chat with the real one
      queryClient.setQueryData<Chat[]>(["chats"], (old) => {
        if (!old) return [newChat];
        return old.map((chat) =>
          chat.id === context?.optimisticChat.id ? newChat : chat,
        );
      });
      setSelectedChatId(newChat.id);
    },
  });

  const updateChatMutation = useMutation({
    mutationFn: (data: { id: string; title: string }) => updateChat({ data }),
    onMutate: async (data) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["chats"] });

      // Snapshot the previous value
      const previousChats = queryClient.getQueryData<Chat[]>(["chats"]);

      // Optimistically update to the new value
      queryClient.setQueryData<Chat[]>(["chats"], (old) => {
        if (!old) return old;
        return old.map((chat) =>
          chat.id === data.id
            ? {
                ...chat,
                title: data.title,
                updatedAt: new Date().toISOString(),
              }
            : chat,
        );
      });

      return { previousChats };
    },
    onError: (_err, _variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousChats) {
        queryClient.setQueryData(["chats"], context.previousChats);
      }
    },
    onSuccess: (updatedChat) => {
      // Update with server response
      queryClient.setQueryData<Chat[]>(["chats"], (old) => {
        if (!old) return old;
        return old.map((chat) =>
          chat.id === updatedChat.id ? updatedChat : chat,
        );
      });
    },
  });

  const deleteChatMutation = useMutation({
    mutationFn: (id: string) => deleteChat({ data: { id } }),
    onMutate: async (id) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["chats"] });

      // Snapshot the previous value
      const previousChats = queryClient.getQueryData<Chat[]>(["chats"]);
      const previousSelectedChatId = selectedChatId;

      // Optimistically update to the new value
      const remainingChats = previousChats?.filter((chat) => chat.id !== id);
      queryClient.setQueryData<Chat[]>(["chats"], remainingChats);

      // If deleting the selected chat, select the next one
      if (selectedChatId === id) {
        if (remainingChats && remainingChats.length > 0) {
          setSelectedChatId(remainingChats[0].id);
        } else {
          setSelectedChatId(null);
        }
      }

      return { previousChats, previousSelectedChatId };
    },
    onError: (_err, _variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousChats) {
        queryClient.setQueryData(["chats"], context.previousChats);
      }
      if (context?.previousSelectedChatId !== undefined) {
        setSelectedChatId(context.previousSelectedChatId);
      }
    },
  });

  const createNewChat = () => {
    const chatNumber = (chats?.length ?? 0) + 1;
    createChatMutation.mutate({ title: `Chat ${chatNumber}` });
  };

  const selectChat = (chatId: string) => {
    setSelectedChatId(chatId);
  };

  const renameChat = (id: string, title: string) => {
    updateChatMutation.mutate({ id, title });
  };

  const removeChatAndSelectNext = (chatId: string) => {
    deleteChatMutation.mutate(chatId);
  };

  return {
    selectedChatId,
    chats,
    selectChat,
    createNewChat,
    renameChat,
    removeChatAndSelectNext,
  };
}
