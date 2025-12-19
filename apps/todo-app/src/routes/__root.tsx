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
import { MobileHeader } from "@/client/components/MobileHeader";
import { EmbeddedAppProvider } from "@/embedded-sdk/client";
import { seo } from "@/client/lib/seo";
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
      ...seo({
        title:
          "TanStack Start | Type-Safe, Client-First, Full-Stack React Framework",
        description: `TanStack Start is a type-safe, client-first, full-stack React framework. `,
      }),
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

  // Always fetch todos regardless of route so that they are preloaded
  useLiveQuery((q) => q.from({ todo: todoCollection }));

  return (
    <>
      {/* Mobile Layout - shown only on screens < 768px */}
      <div className="flex flex-col h-screen md:hidden">
        <MobileHeader currentPath={location.pathname} />
        <div
          className="flex-1 overflow-auto"
          style={{
            paddingTop: "60px",
            paddingBottom: "80px",
          }}
        >
          <Outlet />
        </div>
      </div>

      {/* Desktop Layout - shown only on screens >= 768px */}
      <div className="hidden md:flex h-screen">
        <Sidebar currentPath={location.pathname} />
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </div>
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
            <EmbeddedAppProvider appId={import.meta.env.VITE_APP_ID}>
              <>
                {children}
                <Toaster richColors position="top-right" />
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
