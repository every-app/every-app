import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppLaunchPrefetch } from "@/client/components/AppLaunchPrefetch";
import { AppShell } from "@/client/layout/AppShell";

/**
 * The signed-in pages: a pathless layout, so the sidebar stays mounted while
 * the user moves between them and their URLs do not change. The root route
 * sends a signed-out visitor to /sign-in. The speculation rules that let
 * Chrome prefetch an app on hover live here, once, for every signed-in page.
 */
export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  usePageCodeLoaded();
  return (
    <AppShell>
      <AppLaunchPrefetch />
      <Outlet />
    </AppShell>
  );
}

/**
 * Downloads the code of every signed-in page once the shell is up. Each page
 * is its own chunk, and a click waits for the chunk before it shows the page,
 * so without this the first visit to each page lags by a download. One page
 * at a time: all at once, they take the connection from the requests of the
 * page being opened, which then shows its data seconds later on a slow link.
 */
function usePageCodeLoaded() {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      for (const route of Object.values(router.routesById)) {
        if (stopped) return;
        if (!route.id.startsWith(`${Route.id}/`)) continue;
        // A chunk that fails here is asked for again by the click that needs it.
        await router.loadRouteChunk(route)?.catch(() => undefined);
      }
    };
    void load();
    return () => {
      stopped = true;
    };
  }, [router]);
}
