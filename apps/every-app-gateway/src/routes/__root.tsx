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
import { useEffect } from "react";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import * as React from "react";
import appCss from "@/client/styles/app.css?url";
import { queryClient, persister, CACHE_BUSTER } from "@/client/tanstack-db";
import {
  themePreferenceInitScript,
  useResolvedTheme,
  useThemePreference,
} from "@/client/lib/theme";
import { TooltipProvider } from "@/client/components/ui/tooltip";
import { Toaster } from "sonner";

const PUBLIC_ROUTES = [
  "/setup",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
  // An account verifying its email can't sign in yet.
  "/verify-email",
  // Asks the server whether the user is signed in: it is reached by a full
  // page load straight after sign-in, before the cached session catches up.
  "/oauth/consent",
];

// Inner component that handles routing and session management (must be inside QueryClientProvider)
function AppRouter() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = useSession();
  // Keeps data-theme in step with the OS and the account menu's pick on
  // every page, not only while the menu is open.
  useThemePreference();

  useEffect(() => {
    const isPublicRoute = PUBLIC_ROUTES.includes(location.pathname);

    if (!isPending && !session && !isPublicRoute) {
      // Preserve the current URL (path + search params) as a redirect parameter
      // Use searchStr for the raw query string (location.search is the parsed object)
      const searchStr = location.searchStr || "";
      const currentUrl = location.pathname + searchStr;
      const hasRedirect = currentUrl !== "/";
      navigate({
        to: "/sign-in",
        search: hasRedirect ? { redirect: currentUrl } : undefined,
      });
    }
  }, [session, isPending, navigate, location.pathname, location.searchStr]);

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
      persistOptions={{ persister, buster: CACHE_BUSTER }}
    >
      <TooltipProvider>
        <AppRouter />
        <ThemedToaster />
        {/* <TanStackRouterDevtools /> */}
      </TooltipProvider>
    </PersistQueryClientProvider>
  );
}

/** The toasts follow the page's theme, not only the OS appearance. */
function ThemedToaster() {
  return <Toaster position="bottom-right" theme={useResolvedTheme()} />;
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <head>
        {/* Sets data-theme before the first paint, so a dark theme never
            flashes light. */}
        <script
          dangerouslySetInnerHTML={{ __html: themePreferenceInitScript }}
        />
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content="Every App" />
        <meta
          name="theme-color"
          content="#121212"
          media="(prefers-color-scheme: dark)"
        />
        <meta
          name="theme-color"
          content="#f0f0f0"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="description"
          content="Make every app open source. No subscriptions or paywalls. Own your data. Share with the world."
        />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
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
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>Every App</title>
        <HeadContent />
      </head>
      <body>
        <ClientOnly>{children}</ClientOnly>
        <div
          className="pointer-events-none fixed right-2 bottom-1.5 z-50 hidden font-mono text-[10px] text-muted-foreground opacity-70 select-none md:block"
          title="Gateway build"
        >
          {__GATEWAY_BUILD__}
        </div>
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
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});
