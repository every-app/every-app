import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { chatsCollection } from "@/client/tanstack-db";
import { createChatAction } from "@/client/actions/createChat";
import type { Chat } from "@/db/schema";

/**
 * Hook to get all chats sorted by most recently updated.
 */
export function useSortedChats() {
  const { data: chatsData } = useLiveQuery((q) =>
    q.from({ chat: chatsCollection }),
  );

  const chats = [...(chatsData ?? [])].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  ) as Chat[];

  return chats;
}

/**
 * Hook to create a new chat and navigate to it.
 * Returns a function that can be called to create the chat.
 */
export function useCreateChat() {
  const navigate = useNavigate();
  const chats = useSortedChats();

  const createNewChat = useCallback(async () => {
    const chatNumber = chats.length + 1;
    const newChatId = crypto.randomUUID();
    await createChatAction({
      chatId: newChatId,
      title: `Chat ${chatNumber}`,
    });
    navigate({ to: "/chat/$chatId", params: { chatId: newChatId } });
    return newChatId;
  }, [chats.length, navigate]);

  return createNewChat;
}
