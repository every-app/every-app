import { MessageBubble } from "./MessageBubble";
import { useEffect, useRef, useMemo } from "react";
import type { UIMessage } from "ai";

interface ChatMessagesProps {
  persistedMessages: UIMessage[];
  streamingMessages?: UIMessage[];
  isStreaming?: boolean;
  isLoading?: boolean;
}

export function ChatMessages({
  persistedMessages,
  streamingMessages = [],
  isStreaming = false,
  isLoading = false,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Merge persisted and streaming messages
  const allMessages = useMemo(() => {
    // If we have streaming messages, use them (they include persisted + new)
    if (streamingMessages.length > 0) {
      return streamingMessages;
    }

    // Otherwise, use persisted messages (already in UI format from repository)
    return persistedMessages;
  }, [persistedMessages, streamingMessages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [allMessages]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  // Check if the last message is an assistant message being streamed
  const lastMessage = allMessages[allMessages.length - 1];
  const isLastMessageStreaming =
    isStreaming &&
    lastMessage?.role === "assistant" &&
    lastMessage?.parts?.length === 0;

  return (
    <div className="flex-1 overflow-y-auto p-4 flex justify-center">
      <div className="w-full max-w-2xl space-y-4">
        {allMessages.length > 0 ? (
          allMessages.map((message: UIMessage) => (
            <MessageBubble
              key={message.id}
              message={message}
              isStreaming={isStreaming && message.id === lastMessage?.id}
            />
          ))
        ) : (
          <div className="flex items-center justify-center h-full text-base-content/60">
            <div className="text-center">
              <p className="text-lg mb-2">No messages yet</p>
              <p className="text-sm">Start the conversation below!</p>
            </div>
          </div>
        )}

        {/* Show loading indicator when connection is established but no tokens yet */}
        {isLastMessageStreaming && (
          <div className="chat chat-start">
            <div className="chat-bubble">
              <span className="loading loading-dots loading-sm"></span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} className="h-4" />
      </div>
    </div>
  );
}
