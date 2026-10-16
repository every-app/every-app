import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/client/layout/AppShell";

/**
 * The signed-in pages: a pathless layout, so the sidebar stays mounted while
 * the user moves between them and their URLs do not change. The root route
 * sends a signed-out visitor to /sign-in.
 */
export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
