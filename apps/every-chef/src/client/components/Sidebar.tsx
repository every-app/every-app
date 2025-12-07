import { Link, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  MessageSquare,
  BookOpen,
  ChefHat,
  ChevronRight,
  Menu,
} from "lucide-react";
import { queryClient } from "@/client/tanstack-db";
import { useSortedChats } from "@/client/hooks/useChats";
import { ChatItem } from "./sidebar/ChatItem";
import { getMessages } from "@/serverFunctions/chats";

interface SidebarContentProps {
  onNavigate?: () => void;
}

function SidebarContent({ onNavigate }: SidebarContentProps) {
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

        {/* Recent Chats (only show when Chat section is active) */}
        {isChatSectionActive && recentChats.length > 0 && (
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

/** Desktop sidebar - always visible */
export function Sidebar() {
  return (
    <div className="w-64 border-r border-base-300 h-full">
      <SidebarContent />
    </div>
  );
}

interface DrawerSidebarProps {
  children: React.ReactNode;
  /** Optional content to render on the right side of the mobile navbar */
  navbarRight?: React.ReactNode;
  /** Title to display in the mobile navbar */
  title?: string;
}

/** Mobile drawer sidebar - toggleable */
export function DrawerSidebar({
  children,
  navbarRight,
  title = "Chef",
}: DrawerSidebarProps) {
  const closeDrawer = () => {
    const checkbox = document.getElementById(
      "mobile-drawer",
    ) as HTMLInputElement;
    if (checkbox) {
      checkbox.checked = false;
    }
  };

  return (
    <div className="drawer h-screen overflow-hidden">
      <input id="mobile-drawer" type="checkbox" className="drawer-toggle" />
      <div className="drawer-content flex flex-col h-screen overflow-hidden">
        {/* Navbar with hamburger - fixed at top */}
        <div className="navbar bg-base-100 border-b border-base-300 px-4 min-h-14 flex-shrink-0">
          <div className="flex-none">
            <label
              htmlFor="mobile-drawer"
              aria-label="open sidebar"
              className="btn btn-square btn-ghost btn-sm"
            >
              <Menu className="h-5 w-5" />
            </label>
          </div>
          <div className="flex-1 pl-2">
            <div className="flex items-center gap-2">
              <ChefHat className="h-5 w-5 text-primary" />
              <span className="font-semibold">{title}</span>
            </div>
          </div>
          {navbarRight && <div className="flex-none">{navbarRight}</div>}
        </div>

        {/* Page content - takes remaining space */}
        <div className="flex-1 overflow-hidden min-h-0">{children}</div>
      </div>

      <div className="drawer-side z-50">
        <label
          htmlFor="mobile-drawer"
          aria-label="close sidebar"
          className="drawer-overlay"
        />
        <div className="w-72 min-h-full bg-base-100">
          <SidebarContent onNavigate={closeDrawer} />
        </div>
      </div>
    </div>
  );
}
