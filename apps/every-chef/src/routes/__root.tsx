/// <reference types="vite/client" />
import {
  ClientOnly,
  HeadContent,
  Scripts,
  createRootRoute,
  Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import * as React from "react";
import { DefaultCatchBoundary } from "@/client/components/DefaultCatchBoundary";
import { NotFound } from "@/client/components/NotFound";
import appCss from "@/client/styles/app.css?url";
import { Toaster } from "sonner";
import { Sidebar, DrawerSidebar } from "@/client/components/Sidebar";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { useCreateChat } from "@/client/hooks/useChats";
import { EmbeddedAppProvider } from "@/embedded-sdk/client";
import { queryClient, persister } from "@/client/tanstack-db";
import { Plus, Pencil } from "lucide-react";
import { useLocation, useNavigate, Link } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      {
        name: "apple-mobile-web-app-capable",
        content: "yes",
      },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
      {
        name: "theme-color",
        content: "#242424",
        media: "(prefers-color-scheme: dark)",
      },
      {
        name: "theme-color",
        content: "#f7f7f7",
        media: "(prefers-color-scheme: light)",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
      { rel: "manifest", href: "/site.webmanifest", color: "#fffff" },
      { rel: "icon", href: "/favicon.ico" },
    ],
    scripts: [],
  }),
  component: AppLayout,
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
});

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
    // Parse search params properly instead of using string matching
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

function AppLayout() {
  const isMobile = useIsMobile();
  const pageTitle = usePageTitle();

  if (isMobile) {
    // Mobile layout - drawer sidebar
    return (
      <DrawerSidebar navbarRight={<MobileNavbarRight />} title={pageTitle}>
        <Outlet />
      </DrawerSidebar>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <ClientOnly>
          <PersistQueryClientProvider
            client={queryClient}
            persistOptions={{ persister }}
          >
            <EmbeddedAppProvider appId={import.meta.env.VITE_APP_ID}>
              {children}
              <Toaster
                richColors
                position="bottom-right"
                toastOptions={{
                  className:
                    "!bg-base-300 !text-base-content !shadow-lg !border !border-base-content/20",
                }}
              />
              <TanStackRouterDevtools position="bottom-right" />
            </EmbeddedAppProvider>
          </PersistQueryClientProvider>
        </ClientOnly>
        <Scripts />
      </body>
    </html>
  );
}
