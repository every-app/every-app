import { useSession } from "@/client/hooks/useSession";
import {
  Outlet,
  ClientOnly,
  createRootRoute,
  useLocation,
  useNavigate,
  Scripts,
  HeadContent,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { EmbeddedAppProvider } from "@/client/providers/EmbeddedAppProvider";
import * as React from "react";
import appCss from "@/client/styles/app.css?url";
import { queryClient, persister, clearQueryCache } from "@/client/tanstack-db";
import { Toaster } from "sonner";

const PUBLIC_ROUTES = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
];

// Inner component that handles routing and session management (must be inside QueryClientProvider)
function AppRouter() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = useSession();
  const previousSessionRef = useRef(session);

  // Clear cache when user signs out
  useEffect(() => {
    const wasLoggedIn =
      previousSessionRef.current !== null &&
      previousSessionRef.current !== undefined;
    const isNowLoggedOut = session === null || session === undefined;

    if (!isPending && wasLoggedIn && isNowLoggedOut) {
      // User just signed out - clear cache for security/privacy
      clearQueryCache();
    }

    previousSessionRef.current = session;
  }, [session, isPending]);

  useEffect(() => {
    const isPublicRoute = PUBLIC_ROUTES.includes(location.pathname);

    if (!isPending && !session && !isPublicRoute) {
      navigate({ to: "/sign-in" });
    }
  }, [session, isPending, navigate, location.pathname]);

  return <Outlet />;
}

// Root component that wraps everything with the QueryClientProvider and providers
function RootComponent() {
  // Only render on client to avoid SSR issues with QueryClientProvider
  if (typeof window === "undefined") {
    return null;
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister }}
    >
      <EmbeddedAppProvider>
        <AppRouter />
      </EmbeddedAppProvider>
      <Toaster
        richColors
        position="bottom-right"
        toastOptions={{
          className:
            "!bg-base-300 !text-base-content !shadow-lg !border !border-base-content/20",
        }}
      />
      {/* <TanStackRouterDevtools /> */}
    </PersistQueryClientProvider>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content="Every App" />
        <meta
          name="theme-color"
          content="#242424"
          media="(prefers-color-scheme: dark)"
        />
        <meta
          name="theme-color"
          content="#f7f7f7"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="description"
          content="Make every app open source. No subscriptions or paywalls. Own your data. Share with the world."
        />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
        />
        <title>Every App</title>
        <HeadContent />
      </head>
      <body>
        <ClientOnly>{children}</ClientOnly>
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});
