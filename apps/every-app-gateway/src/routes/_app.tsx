import { createFileRoute, Outlet } from "@tanstack/react-router";
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
  return (
    <AppShell>
      <AppLaunchPrefetch />
      <Outlet />
    </AppShell>
  );
}
