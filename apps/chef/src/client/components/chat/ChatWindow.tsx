import { MessageBubble } from "./MessageBubble";
import type { UIMessage } from "ai";
import type { Recipe } from "@/db/schema";

interface ChatWindowProps {
  chatId?: string;
  messages: UIMessage[];
  isStreaming?: boolean;
  activeRecipes?: Recipe[];
  onToolAction?: (
    toolCallId: string,
    action: "create" | "update" | "ignore",
    recipeId?: string,
  ) => void;
}

export function ChatWindow({
  messages,
  isStreaming = false,
  activeRecipes = [],
  onToolAction,
}: ChatWindowProps) {
  // Check if the last message is an assistant message being streamed
  const lastMessage = messages[messages.length - 1];
  const isLastMessageStreaming =
    isStreaming &&
    lastMessage?.role === "assistant" &&
    lastMessage?.parts?.length === 0;

  return (
    <div className="p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        {messages && messages.length > 0 ? (
          messages.map((message: UIMessage) => (
            <MessageBubble
              key={message.id}
              message={message}
              isStreaming={isStreaming && message.id === lastMessage?.id}
              activeRecipes={activeRecipes}
              onToolAction={onToolAction}
            />
          ))
        ) : (
          <div className="flex items-center justify-center h-full text-base-content/60">
            <div className="text-center py-12">
              <p className="text-lg mb-2">Welcome to Chef!</p>
              <p className="text-sm">
                Ask me anything about cooking, recipes, or ingredients.
              </p>
            </div>
          </div>
        )}

        {/* Show loading indicator when connection is established but no tokens yet */}
        {isLastMessageStreaming && (
          <div className="flex justify-start">
            <div className="chat-message-assistant">
              <span className="loading loading-dots loading-sm"></span>
            </div>
          </div>
        )}

        <div className="h-4" />
      </div>
    </div>
  );
}
