import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { UIMessage } from "ai";
import { getMessages } from "@/serverFunctions/chats";
import { useChatWithAuth } from "@/client/hooks/useChatWithAuth";
import { ChatMessages } from "./ChatMessages";
import { MessageInput } from "./MessageInput";

interface ChatWindowProps {
  chatId: string;
}

export function ChatWindow({ chatId }: ChatWindowProps) {
  const { data: persistedMessages, isLoading } = useQuery({
    queryKey: ["messages", chatId],
    queryFn: () => getMessages({ data: { chatId } }),
  });

  const initialMessages = useMemo(() => {
    if (!persistedMessages) return [];
    return persistedMessages as UIMessage[];
  }, [persistedMessages]);

  const { streamingMessages, handleSendMessage, isStreaming, stop } =
    useChatWithAuth({
      selectedChatId: chatId,
      initialMessages,
    });

  return (
    <>
      <ChatMessages
        persistedMessages={initialMessages}
        streamingMessages={streamingMessages}
        isStreaming={isStreaming}
        isLoading={isLoading}
      />
      <MessageInput
        onSendMessage={handleSendMessage}
        disabled={isStreaming}
        isStreaming={isStreaming}
        onStop={stop}
      />
    </>
  );
}
