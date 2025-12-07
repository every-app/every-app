import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { ChatWindow } from "@/client/components/chat/ChatWindow";
import { MessageInput } from "@/client/components/chat/MessageInput";
import { createChatAction } from "@/client/actions/createChat";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { useSortedChats, useCreateChat } from "@/client/hooks/useChats";

export const Route = createFileRoute("/")({
  component: ChatLandingPage,
});

function ChatLandingPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const pendingMessageRef = useRef<string | null>(null);
  const chats = useSortedChats();
  const createNewChat = useCreateChat();

  // Auto-redirect to most recent chat if one exists
  useEffect(() => {
    if (chats.length > 0) {
      navigate({ to: "/chat/$chatId", params: { chatId: chats[0].id } });
    }
  }, [chats, navigate]);

  // Handle sending a message - create a chat first then navigate
  const handleSendMessage = async (message: string) => {
    if (!message.trim() || pendingMessageRef.current) return;

    pendingMessageRef.current = message;

    const chatNumber = chats.length + 1;
    const newChatId = crypto.randomUUID();

    // Create the chat (optimistically + server) - must complete before we can send messages
    await createChatAction({
      chatId: newChatId,
      title: `Chat ${chatNumber}`,
    });

    // Navigate to the new chat with the pending message in search params
    navigate({
      to: "/chat/$chatId",
      params: { chatId: newChatId },
      search: { pendingMessage: message },
    });
  };

  // Show chat interface even without an active chat
  return (
    <div className="flex flex-col h-full bg-base-200">
      {/* Fixed header - only show on desktop, mobile uses drawer navbar */}
      {!isMobile && (
        <div className="flex-shrink-0 border-b border-base-300 bg-base-200">
          <div className="max-w-2xl mx-auto px-4 py-4">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="page-title">Chef</h1>
                <p className="text-base-content/70 mt-1">
                  Your personal cooking assistant
                </p>
              </div>
              <button
                onClick={createNewChat}
                className="btn btn-primary btn-sm gap-1"
              >
                <Plus className="h-4 w-4" />
                New Chat
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scrollable chat area */}
      <div className="flex-1 overflow-auto scrollbar-stable min-h-0">
        <ChatWindow messages={[]} isStreaming={false} />
      </div>

      {/* Fixed input at bottom */}
      <div className="flex-shrink-0">
        <MessageInput
          onSendMessage={handleSendMessage}
          disabled={false}
          isStreaming={false}
          placeholder="What would you like to cook?"
        />
      </div>
    </div>
  );
}
