import { useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { authenticatedFetch } from "@every-app/sdk/client";
import { toast } from "sonner";

// Note: toast import is used by the onError callback in useChat

interface UseChatWithAuthProps {
  selectedChatId: string | undefined;
  initialMessages: UIMessage[];
}

export function useChatWithAuth({
  selectedChatId,
  initialMessages,
}: UseChatWithAuthProps) {
  const {
    messages: streamingMessages,
    sendMessage,
    status,
    stop,
    addToolOutput,
  } = useChat({
    id: selectedChatId || undefined,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: authenticatedFetch,
      prepareSendMessagesRequest: ({ messages }: { messages: UIMessage[] }) => {
        // Only send the last message (the new one) to the server
        const newMessage = messages[messages.length - 1];
        return {
          body: {
            chatId: selectedChatId,
            message: newMessage,
          },
        };
      },
    }),
    onError: (error: Error) => {
      toast.error("Failed to send message");
      console.error("Chat error:", error);
    },
  });

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!selectedChatId || !content.trim()) return;

      const parts: UIMessage["parts"] = [{ type: "text", text: content }];

      // Send message to chat API
      // Note: Errors are handled by the onError callback in useChat config
      sendMessage({
        role: "user",
        parts,
      });
    },
    [selectedChatId, sendMessage],
  );

  return {
    streamingMessages,
    handleSendMessage,
    status,
    stop,
    addToolOutput,
    isStreaming: status === "streaming",
  };
}
