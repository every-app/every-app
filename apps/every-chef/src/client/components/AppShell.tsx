import { useState } from "react";
import { Outlet, useNavigate, useLocation, Link } from "@tanstack/react-router";
import { Plus, Pencil, Menu, ChefHat } from "lucide-react";
import { useCreateChat } from "@/client/hooks/useChats";
import { SidebarNav } from "./sidebar/SidebarNav";

/**
 * Hook to determine the page title based on current route
 */
function usePageTitle() {
  const location = useLocation();

  if (
    location.pathname === "/recipes" ||
    location.pathname.startsWith("/recipes/")
  ) {
    return "Recipes";
  }
  if (location.pathname === "/chats") {
    return "Chats";
  }
  // Default for chat pages and home
  return "Chef";
}

/**
 * Mobile navbar right-side actions (route-specific)
 */
function MobileNavbarRight() {
  const location = useLocation();
  const navigate = useNavigate();
  const createNewChat = useCreateChat();

  const isOnChatPage =
    location.pathname === "/" || location.pathname.startsWith("/chat");
  const isOnRecipesPage = location.pathname === "/recipes";

  // Chat pages: New Chat button
  if (isOnChatPage) {
    return (
      <button
        onClick={createNewChat}
        className="btn btn-primary btn-sm btn-square"
        aria-label="New Chat"
      >
        <Plus className="h-4 w-4" />
      </button>
    );
  }

  // Recipes page: Edit toggle + New Recipe button
  if (isOnRecipesPage) {
    const searchParams = new URLSearchParams(location.searchStr || "");
    const isEditMode = searchParams.get("edit") === "true";

    const toggleEditMode = () => {
      navigate({
        to: "/recipes",
        search: isEditMode ? {} : { edit: true },
        replace: true,
      });
    };

    if (isEditMode) {
      return (
        <button
          onClick={toggleEditMode}
          className="btn btn-sm btn-outline"
          aria-label="Done editing"
        >
          Done
        </button>
      );
    }

    return (
      <div className="flex gap-2">
        <button
          onClick={toggleEditMode}
          className="btn btn-sm btn-ghost btn-square"
          aria-label="Edit recipes"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <Link to="/recipes/new" className="btn btn-primary btn-sm btn-square">
          <Plus className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  return null;
}

/**
 * AppShell provides the main layout structure for the app:
 * - Responsive drawer (hamburger on mobile, always-open sidebar on desktop)
 * - Mobile navbar with page title and route-specific actions
 * - Main content area
 */
export function AppShell() {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const pageTitle = usePageTitle();

  return (
    <div className="drawer md:drawer-open h-screen overflow-hidden">
      <input
        id="mobile-drawer"
        type="checkbox"
        className="drawer-toggle"
        checked={isDrawerOpen}
        onChange={(e) => setIsDrawerOpen(e.target.checked)}
      />
      <div className="drawer-content flex flex-col h-screen overflow-hidden">
        {/* Mobile navbar - hidden on desktop */}
        <div className="navbar bg-base-100 border-b border-base-300 px-4 min-h-14 flex-shrink-0 md:hidden">
          <div className="flex-none">
            <button
              onClick={() => setIsDrawerOpen(true)}
              aria-label="open sidebar"
              className="btn btn-square btn-ghost btn-sm"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 pl-2">
            <div className="flex items-center gap-2">
              <ChefHat className="h-5 w-5 text-primary" />
              <span className="font-semibold">{pageTitle}</span>
            </div>
          </div>
          <div className="flex-none">
            <MobileNavbarRight />
          </div>
        </div>

        {/* Page content */}
        <div className="main-content flex-1 overflow-hidden min-h-0">
          <Outlet />
        </div>
      </div>

      <div className="drawer-side z-50">
        <label
          htmlFor="mobile-drawer"
          aria-label="close sidebar"
          className="drawer-overlay"
        />
        <div className="sidebar w-72 min-h-full bg-base-100 border-r border-base-300">
          <SidebarNav onNavigate={() => setIsDrawerOpen(false)} />
        </div>
      </div>
    </div>
  );
}
