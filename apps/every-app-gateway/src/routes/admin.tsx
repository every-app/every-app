import {
  createFileRoute,
  Outlet,
  Link,
  useLocation,
} from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { authClient } from "@/client/auth-client";
import { Header } from "@/client/components/Header";
import { Monitor, Users, AppWindow, KeyRound } from "lucide-react";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

const adminTabs = [
  { path: "/admin/users", label: "Users", icon: Users },
  { path: "/admin/apps", label: "Apps", icon: AppWindow },
  { path: "/admin/tokens", label: "App Tokens", icon: KeyRound },
];

function AdminLayout() {
  const { data: session, isPending } = useSession();
  const { data: activeMemberRole, isPending: isRolePending } =
    authClient.useActiveMemberRole();
  const location = useLocation();

  // Show loading while checking session
  if (isPending || isRolePending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  const hasAdminAccess =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";

  if (!session || !hasAdminAccess) {
    return (
      <div className="bg-base-100 h-screen flex flex-col">
        <Header email={session?.user.email} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Access Denied</h1>
            <p className="text-base-content/70 mt-2">
              You don't have permission to access this page.
            </p>
            <Link to="/" className="btn btn-primary mt-4">
              Go Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-base-100 h-screen flex flex-col overflow-hidden">
      <Header email={session.user.email} />
      {/* Mobile alert - shown on small screens */}
      <div className="sm:hidden flex-1 flex items-center justify-center p-4">
        <div className="alert alert-info max-w-md">
          <Monitor className="w-6 h-6" />
          <div>
            <h3 className="font-bold">Coming Soon</h3>
            <p className="text-sm">
              Admin features aren't supported on mobile yet. Please access this
              page from a computer.
            </p>
          </div>
        </div>
      </div>
      {/* Desktop content - hidden on small screens */}
      <div className="hidden sm:flex flex-col flex-1 overflow-hidden">
        {/* Admin navigation tabs */}
        <div className="border-b border-base-300">
          <div className="max-w-4xl mx-auto px-4">
            <div className="tabs tabs-bordered">
              {adminTabs.map((tab, index) => {
                const Icon = tab.icon;
                const isActive = location.pathname === tab.path;
                return (
                  <Link
                    key={tab.path}
                    to={tab.path}
                    className={`tab gap-2 ${index === 0 ? "!pl-0" : ""} ${isActive ? "tab-active" : ""}`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{tab.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-4 py-6">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
