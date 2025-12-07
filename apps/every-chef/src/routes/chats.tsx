import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "@/client/components/ui/empty-state";
import { useSortedChats, useCreateChat } from "@/client/hooks/useChats";
import { MessageSquare, Plus, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/chats")({
  component: ChatsPage,
});

function ChatsPage() {
  const chats = useSortedChats();
  const createNewChat = useCreateChat();

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (diffDays === 0) {
      return "Today";
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  return (
    <div className="page-container overflow-auto h-full pt-6">
      {/* Page Header */}
      <div className="page-header mb-6">
        <div>
          <h1 className="page-title">All Chats</h1>
          <p className="text-base-content/70 mt-1">Your conversation history</p>
        </div>
        <button
          onClick={createNewChat}
          className="btn btn-primary btn-sm gap-1"
        >
          <Plus size={16} />
          <span>New Chat</span>
        </button>
      </div>

      {/* Chats List */}
      {chats.length === 0 ? (
        <EmptyState
          icon={<MessageSquare className="h-12 w-12 mx-auto" />}
          title="No Chats Yet"
          description="Start a conversation with your personal chef assistant."
          action={
            <button onClick={createNewChat} className="btn btn-primary">
              Start a Chat
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {chats.map((chat) => (
            <Link
              key={chat.id}
              to="/chat/$chatId"
              params={{ chatId: chat.id }}
              className="program-card flex items-center gap-3 hover:border-primary/30"
            >
              <div className="flex-shrink-0">
                <div className="w-10 h-10 rounded-full bg-base-200 flex items-center justify-center">
                  <MessageSquare className="h-5 w-5 text-base-content/60" />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-base-content truncate">
                  {chat.title}
                </h3>
                <p className="text-sm text-base-content/60">
                  {formatDate(chat.updatedAt)}
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-base-content/40 flex-shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
