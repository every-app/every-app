/// <reference types="vite/client" />
import * as React from "react";
import {
  ClientOnly,
  HeadContent,
  Scripts,
  createRootRoute,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { DefaultCatchBoundary } from "@/client/components/DefaultCatchBoundary";
import { NotFound } from "@/client/components/NotFound";
import appCss from "@/client/styles/app.css?url";
import { Toaster } from "sonner";
import { Sidebar } from "@/client/components/Sidebar";
import { TabBar } from "@/client/components/TabBar";
import { KeyboardShortcutsModal } from "@/client/components/KeyboardShortcutsModal";

import { queryClient } from "@/client/queryClient";
import { persister } from "@/client/persister";
import { useTodos } from "@/client/queries/todos";
import { useGlobalHotkeys } from "@/client/hooks/useGlobalHotkeys";
import { useSyncEvents } from "@/client/sync/useSyncEvents";

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
      // use-credentials: manifest fetches omit cookies by default, and behind
      // the gateway perimeter an uncredentialed request is a 401.
      {
        rel: "manifest",
        href: "/site.webmanifest",
        crossOrigin: "use-credentials",
        color: "#fffff",
      },
      { rel: "icon", href: "/favicon.ico" },
    ],
    scripts: [],
  }),
  component: AppLayout,
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
});

function AppLayout() {
  const location = useLocation();
  const [showShortcuts, setShowShortcuts] = React.useState(false);

  // Global keyboard shortcuts
  useGlobalHotkeys({ onShowShortcuts: () => setShowShortcuts(true) });

  // Always fetch todos regardless of route so that they are preloaded
  useTodos();

  // Connect to sync WebSocket for real-time updates across devices
  useSyncEvents();

  // Use CSS-based responsive design to avoid hydration mismatch
  // The same HTML structure is rendered on server and client
  return (
    <>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-base-200 md:flex-row">
        {/* Desktop: Sidebar */}
        <div className="hidden md:block">
          <Sidebar
            currentPath={location.pathname}
            onShowShortcuts={() => setShowShortcuts(true)}
          />
        </div>

        {/* Main content */}
        <div className="main-content flex-1 min-h-0 overflow-hidden pt-safe md:pt-0 md:pb-0 pb-[80px]">
          <Outlet />
        </div>

        {/* Mobile: TabBar */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-50">
          <TabBar currentPath={location.pathname} />
        </div>
      </div>

      <KeyboardShortcutsModal
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </>
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
            <>
              {children}
              <Toaster
                richColors
                position="bottom-right"
                mobileOffset={{ bottom: 100 }}
                toastOptions={{
                  className:
                    "!bg-base-300 !text-base-content !shadow-lg !border !border-base-content/20",
                }}
              />
              <TanStackRouterDevtools position="bottom-right" />
            </>
          </PersistQueryClientProvider>
        </ClientOnly>
        <Scripts />
      </body>
    </html>
  );
}
