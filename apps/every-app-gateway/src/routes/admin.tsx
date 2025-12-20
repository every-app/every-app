import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { useSession } from "@/client/hooks/useSession";
import { Header } from "@/client/components/Header";

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
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
