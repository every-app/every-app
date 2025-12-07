import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { getChats, createChat } from "@/serverFunctions/chats";
import { ChatSidebar } from "@/client/components/ChatSidebar";
import type { Chat } from "@/types";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: chats } = useQuery({
    queryKey: ["chats"],
    queryFn: () => getChats(),
  });

  // Auto-redirect to most recent chat if one exists
  useEffect(() => {
    if (chats && chats.length > 0) {
      navigate({ to: "/chat/$chatId", params: { chatId: chats[0].id } });
    }
  }, [chats, navigate]);

  const createChatMutation = useMutation({
    mutationFn: (data: { id: string; title: string }) => createChat({ data }),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: ["chats"] });
      const previousChats = queryClient.getQueryData<Chat[]>(["chats"]);

      const optimisticChat: Chat = {
        id: data.id,
        userId: "",
        title: data.title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      queryClient.setQueryData<Chat[]>(["chats"], (old) => [
        optimisticChat,
        ...(old || []),
      ]);

      return { previousChats };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousChats) {
        queryClient.setQueryData(["chats"], context.previousChats);
      }
    },
    onSuccess: (newChat) => {
      queryClient.setQueryData<Chat[]>(["chats"], (old) => {
        if (!old) return [newChat];
        return old.map((chat) => (chat.id === newChat.id ? newChat : chat));
      });
      navigate({ to: "/chat/$chatId", params: { chatId: newChat.id } });
    },
  });

  const createNewChat = () => {
    const chatNumber = (chats?.length ?? 0) + 1;
    const newChatId = crypto.randomUUID();
    createChatMutation.mutate({ id: newChatId, title: `Chat ${chatNumber}` });
    // Navigate immediately with optimistic ID
    navigate({ to: "/chat/$chatId", params: { chatId: newChatId } });
  };

  // Show welcome screen if no chats exist
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <ChatSidebar activeChatId={null} />

      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex items-center justify-center text-base-content/60">
          <div className="text-center">
            <p className="text-lg mb-2">Welcome to Every LLM Chat</p>
            <p className="text-sm mb-4">Create a new chat to get started</p>
            <button onClick={createNewChat} className="btn btn-primary gap-2">
              <Plus size={16} />
              New Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
