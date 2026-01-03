import { useCallback, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { authenticatedFetch } from "@every-app/sdk/client";
import { toast } from "sonner";

interface UseChatWithAuthProps {
  selectedChatId: string | undefined;
  initialMessages: UIMessage[];
  onUserMessage?: (message: UIMessage) => void;
  onAssistantMessage?: (message: UIMessage) => void;
}

export function useChatWithAuth({
  selectedChatId,
  initialMessages,
  onUserMessage,
  onAssistantMessage,
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

  // Track previous status to detect when streaming finishes
  const prevStatusRef = useRef(status);

  // When streaming finishes, add the assistant message to cache
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === "streaming";
    const isNowReady = status === "ready";

    if (wasStreaming && isNowReady && onAssistantMessage) {
      // Find the last assistant message
      const lastMessage = streamingMessages[streamingMessages.length - 1];
      if (lastMessage?.role === "assistant") {
        onAssistantMessage(lastMessage);
      }
    }

    prevStatusRef.current = status;
  }, [status, streamingMessages, onAssistantMessage]);

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!selectedChatId || !content.trim()) return;

      const parts: UIMessage["parts"] = [{ type: "text", text: content }];

      const userMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts,
      };

      // Optimistically add user message to cache
      onUserMessage?.(userMessage);

      // Send message to chat API
      sendMessage({
        role: "user",
        parts,
      });
    },
    [selectedChatId, sendMessage, onUserMessage],
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
