import { useCallback, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { authenticatedFetch } from "@every-app/sdk/core";
import { toast } from "sonner";
import { fileToDataUrl } from "../utils/file";

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
    async (content: string, imageFile?: File) => {
      if (!selectedChatId || (!content.trim() && !imageFile)) return;

      const parts: UIMessage["parts"] = [];
      let imagePreviewUrl: string | null = null;

      // If there's an image, create a preview URL for optimistic display
      if (imageFile) {
        imagePreviewUrl = await fileToDataUrl(imageFile);

        // Add image part with preview URL for optimistic display
        parts.push({
          type: "file",
          url: imagePreviewUrl,
          mediaType: imageFile.type,
        });
      }

      // Add text part if there's content
      if (content.trim()) {
        parts.push({ type: "text", text: content });
      }

      const userMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts,
      };

      // Optimistically add user message to cache with preview URL
      onUserMessage?.(userMessage);

      try {
        // If there's an image, upload it to R2 first
        let r2Key: string | null = null;
        if (imageFile) {
          const formData = new FormData();
          formData.append("file", imageFile);
          formData.append("chatId", selectedChatId);

          const uploadResponse = await authenticatedFetch("/api/upload", {
            method: "POST",
            body: formData,
          });

          if (!uploadResponse.ok) {
            const errorData = (await uploadResponse
              .json()
              .catch(() => ({}))) as {
              error?: string;
            };
            toast.error(
              errorData.error || "Failed to upload image. Please try again.",
            );
            return;
          }

          const data = (await uploadResponse.json()) as { key: string };
          r2Key = data.key;
        }

        // Build the final parts with R2 key instead of data URL
        const finalParts: UIMessage["parts"] = [];
        if (r2Key) {
          finalParts.push({
            type: "file",
            url: r2Key,
            mediaType: imageFile?.type || "image/jpeg",
          });
        }
        if (content.trim()) {
          finalParts.push({ type: "text", text: content });
        }

        // Send message to chat API
        sendMessage({
          role: "user",
          parts: finalParts,
        });
      } catch (error) {
        console.error("Failed to send message:", error);
        toast.error("Failed to send message. Please try again.");
      }
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
