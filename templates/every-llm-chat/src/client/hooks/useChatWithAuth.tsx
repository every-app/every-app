import { useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { authenticatedFetch } from "@every-app/sdk/client";
import { toast } from "sonner";

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
  } = useChat({
    id: selectedChatId || undefined,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: authenticatedFetch,
      prepareSendMessagesRequest: ({ messages }) => {
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
    async (content: string, imageFile?: File) => {
      if (!selectedChatId || !content.trim()) return;

      try {
        const parts: UIMessage["parts"] = [{ type: "text", text: content }];

        if (imageFile) {
          // 1. Upload image first
          const formData = new FormData();
          formData.append("file", imageFile);
          formData.append("chatId", selectedChatId);

          const uploadResponse = await authenticatedFetch("/api/upload", {
            method: "POST",
            body: formData,
          });

          if (!uploadResponse.ok) {
            throw new Error("Failed to upload image");
          }

          const { key } = (await uploadResponse.json()) as { key: string };

          // 2. Add image part with the R2 key
          parts.unshift({
            type: "file",
            url: key,
            mediaType: imageFile.type,
          });
        }

        // 3. Send message to chat API (JSON)
        sendMessage({
          role: "user",
          parts,
        });
      } catch (error) {
        toast.error("Failed to send message");
        console.error("Message send error:", error);
      }
    },
    [selectedChatId, sendMessage],
  );

  return {
    streamingMessages,
    handleSendMessage,
    status,
    stop,
    isStreaming: status === "streaming",
  };
}
