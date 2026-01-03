import { Link, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { MessageSquare, BookOpen, ChefHat, ChevronRight } from "lucide-react";
import { queryClient } from "@/client/tanstack-db";
import { useSortedChats } from "@/client/hooks/useChats";
import { ChatItem } from "./ChatItem";
import { getMessages } from "@/serverFunctions/chats";

interface SidebarNavProps {
  onNavigate?: () => void;
}

/**
 * Sidebar navigation content including:
 * - App header with logo
 * - Chef/Chat section with recent chats
 * - Recipes section
 */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const location = useLocation();
  const currentPath = location.pathname;
  const sortedChats = useSortedChats();
  const recentChats = sortedChats.slice(0, 5);

  // Prefetch messages for visible chats
  useEffect(() => {
    recentChats.forEach((chat) => {
      queryClient.prefetchQuery({
        queryKey: ["messages", chat.id],
        queryFn: () => getMessages({ data: { chatId: chat.id } }),
        staleTime: 1000 * 60 * 5, // 5 minutes
      });
    });
  }, [recentChats]);

  // Extract chat ID from URL if on a chat page
  const chatMatch = currentPath.match(/^\/chat\/([^/]+)/);
  const activeChatId = chatMatch ? chatMatch[1] : null;

  const isOnChatPage = currentPath === "/" || currentPath.startsWith("/chat/");
  const isOnChatsListPage = currentPath.startsWith("/chats");
  const isChatSectionActive = isOnChatPage || isOnChatsListPage;
  const isRecipesActive = currentPath.startsWith("/recipes");

  return (
    <div className="bg-base-100 h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-4 border-b border-base-300">
        <div className="flex items-center gap-2">
          <ChefHat className="h-5 w-5 text-primary" />
          <span className="font-semibold text-base-content">Chef</span>
          <span className="text-base-content/40">-</span>
          <a
            href={import.meta.env.VITE_GATEWAY_URL}
            target="_top"
            className="text-base-content/60 hover:text-primary transition-colors text-sm"
          >
            Every App
          </a>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 pl-3 overflow-y-auto">
        {/* Chef/Chat Section Header */}
        <Link
          to="/"
          onClick={onNavigate}
          className={`relative flex items-center gap-3 pl-4 pr-4 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none ${
            isChatSectionActive
              ? "text-base-content font-medium"
              : "text-base-content/60 hover:text-base-content hover:bg-base-200"
          }`}
        >
          <MessageSquare
            className={`h-5 w-5 ${isChatSectionActive ? "text-primary" : ""}`}
          />
          Chef
        </Link>

        {/* Recent Chats - always show */}
        {recentChats.length > 0 && (
          <div className="ml-4 pl-4 border-l border-base-300">
            {recentChats.map((chat) => {
              const isActiveChat = chat.id === activeChatId;
              return (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  isActive={isActiveChat}
                  onNavigate={onNavigate}
                />
              );
            })}

            {/* See All Chats button */}
            <Link
              to="/chats"
              onClick={onNavigate}
              className="flex items-center gap-2 py-2 px-2 text-sm text-base-content/50 hover:text-base-content hover:bg-base-200 rounded-lg transition-colors mt-1"
            >
              <span>See all chats</span>
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        )}

        {/* Recipes Section */}
        <Link
          to="/recipes"
          search={{}}
          onClick={onNavigate}
          className={`relative flex items-center gap-3 pl-4 pr-4 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none mt-1 ${
            isRecipesActive
              ? "text-base-content font-medium"
              : "text-base-content/60 hover:text-base-content hover:bg-base-200"
          }`}
        >
          {isRecipesActive && (
            <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-primary rounded-r-full" />
          )}
          <BookOpen
            className={`h-5 w-5 ${isRecipesActive ? "text-primary" : ""}`}
          />
          Recipes
        </Link>
      </nav>
    </div>
  );
}
