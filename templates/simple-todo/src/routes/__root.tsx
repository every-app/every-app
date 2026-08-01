/// <reference types="vite/client" />
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
import * as React from "react";
import { DefaultCatchBoundary } from "@/client/components/DefaultCatchBoundary";
import { NotFound } from "@/client/components/NotFound";
import appCss from "@/client/styles/app.css?url";
import { Toaster } from "sonner";
import { Sidebar } from "@/client/components/Sidebar";
import { TabBar } from "@/client/components/TabBar";
import { persister } from "@/client/persister";
import { queryClient } from "@/client/queryClient";
import { useTodos } from "@/client/queries/todos";

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

  // Always fetch todos regardless of route so that they are preloaded
  useTodos();

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] overflow-hidden bg-base-200">
      {/* Desktop: Sidebar */}
      <div className="hidden md:block">
        <Sidebar currentPath={location.pathname} />
      </div>

      {/* Main content */}
      <div className="main-content flex-1 min-h-0 overflow-auto pt-safe md:pt-0 md:pb-0 pb-[80px]">
        <Outlet />
      </div>

      {/* Mobile: TabBar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50">
        <TabBar currentPath={location.pathname} />
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
            <>
              {children}
              <Toaster position="bottom-right" mobileOffset={{ bottom: 100 }} />
              <TanStackRouterDevtools position="bottom-right" />
            </>
          </PersistQueryClientProvider>
        </ClientOnly>
        <Scripts />
      </body>
    </html>
  );
}
