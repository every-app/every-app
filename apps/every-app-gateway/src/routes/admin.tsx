import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { Header } from "@/client/components/Header";
import { Monitor } from "lucide-react";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  const { data: session, isPending } = useSession();

  // Show loading while checking session
  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  // Check if user is owner
  if (!session || session.user.role !== "owner") {
    return (
      <div className="bg-base-100 h-screen flex flex-col">
        <Header email={session?.user.email} role={session?.user.role} />
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
      <Header email={session.user.email} role={session.user.role} />
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
      <div className="hidden sm:block flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
