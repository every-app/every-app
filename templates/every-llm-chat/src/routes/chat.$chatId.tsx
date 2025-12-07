import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getChats, getMessages } from "@/serverFunctions/chats";
import { ChatSidebar } from "@/client/components/ChatSidebar";
import { ChatWindow } from "@/client/components/ChatWindow";

export const Route = createFileRoute("/chat/$chatId")({
  component: ChatPage,
});

function ChatPage() {
  const { chatId } = Route.useParams();
  const navigate = useNavigate();

  // Get all chats to verify this chat exists
  const { data: chats } = useQuery({
    queryKey: ["chats"],
    queryFn: () => getChats(),
  });

  const chat = chats?.find((c) => c.id === chatId);

  // Redirect to home if chat doesn't exist
  useEffect(() => {
    if (chats && !chat) {
      navigate({ to: "/" });
    }
  }, [chats, chat, navigate]);

  // Prefetch messages for this chat
  useQuery({
    queryKey: ["messages", chatId],
    queryFn: () => getMessages({ data: { chatId } }),
    enabled: !!chatId,
  });

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <ChatSidebar activeChatId={chatId} />

      <div className="flex-1 flex flex-col">
        {chat ? (
          <ChatWindow chatId={chatId} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="loading loading-spinner loading-lg"></span>
          </div>
        )}
      </div>
    </div>
  );
}
