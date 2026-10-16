import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useSession } from "@/client/hooks/useSession";
import { authClient } from "@/client/auth-client";
import { EmptyState } from "@/client/components/EmptyState";
import { SkeletonPage } from "@/client/components/SkeletonPresets";
import { StatusScreen } from "@/client/components/StatusScreen";
import { Button } from "@/client/components/ui/button";

export const Route = createFileRoute("/_app/admin")({
  component: AdminLayout,
});

// The admin pages' gate. The sidebar carries their navigation.
function AdminLayout() {
  const { data: session, isPending } = useSession();
  const { data: activeMemberRole, isPending: isRolePending } =
    authClient.useActiveMemberRole();

  // Show loading while checking session
  if (isPending || isRolePending) {
    return <SkeletonPage />;
  }

  const hasAdminAccess =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";

  if (!session || !hasAdminAccess) {
    return (
      <StatusScreen>
        <EmptyState
          variant="card"
          icon={ShieldAlert}
          title="You don't have access to this page"
          description="Only owners and admins of this organization can manage users, apps and tokens."
          action={
            <Button nativeButton={false} render={<Link to="/" />}>
              Go home
            </Button>
          }
        />
      </StatusScreen>
    );
  }

  return <Outlet />;
}
