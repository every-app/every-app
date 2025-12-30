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
import { EmbeddedAppProvider } from "@every-app/sdk/client";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { getTransitionType } from "@/client/lib/utils";

import { todoCollection, queryClient, persister } from "@/client/tanstack-db";
import { useLiveQuery } from "@tanstack/react-db";

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

function AppLayout() {
  const location = useLocation();
  const isMobile = useIsMobile();
  const lastPathRef = React.useRef(location.pathname);

  // Set transition type before navigation occurs
  React.useEffect(() => {
    const currentPath = location.pathname;
    const lastPath = lastPathRef.current;

    if (currentPath !== lastPath) {
      const transitionType = getTransitionType({
        from: lastPath,
        to: currentPath,
        isMobile: isMobile ?? false,
      });
      document.documentElement.dataset.transition = transitionType;
      lastPathRef.current = currentPath;
    }
  }, [location.pathname, isMobile]);

  // Always fetch todos regardless of route so that they are preloaded
  useLiveQuery((q) => q.from({ todo: todoCollection }));

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-base-200">
        <div
          className="main-content flex-1 overflow-auto"
          style={{
            paddingBottom: "60px",
          }}
        >
          <Outlet />
        </div>
        <TabBar currentPath={location.pathname} />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-base-200">
      <Sidebar currentPath={location.pathname} />
      <div className="main-content flex-1 overflow-auto">
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
              <>
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
              </>
            </EmbeddedAppProvider>
          </PersistQueryClientProvider>
        </ClientOnly>
        <Scripts />
      </body>
    </html>
  );
}
