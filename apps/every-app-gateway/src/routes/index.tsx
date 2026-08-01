import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useSession } from "@/client/hooks/useSession";
import { userAppsCollection } from "@/client/tanstack-db";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { Settings } from "lucide-react";
import { PWAInstallModal } from "@/client/components/PWAInstallModal";
import { OnboardingBanner } from "@/client/components/onboarding/OnboardingBanner";
import { AppListItem } from "@/client/components/AppListItem";
import { Header } from "@/client/components/Header";
import { authClient } from "@/client/auth-client";

const searchSchema = z.object({
  // Handle both boolean (from programmatic navigation) and string (from URL)
  // Falls back to undefined for any invalid values to prevent hard crashes
  pwa: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((val) => val === true || val === "true")
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: App,
});

function App() {
  const session = useSession();
  const { pwa: pwaParam } = Route.useSearch();
  const [showPWAInstallModal, setShowPWAInstallModal] = useState(false);
  const navigate = useNavigate();
  const hasStrippedPwaParam = useRef(false);
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const userCanManageApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";

  useEffect(() => {
    if (session.isPending || !session.data?.user) {
      return;
    }

    if (!session.data.session.activeOrganizationId) {
      navigate({ to: "/organizations" });
    }
  }, [
    navigate,
    session.data?.session.activeOrganizationId,
    session.data?.user,
    session.isPending,
  ]);

  // Open PWA modal when ?pwa=true is present, then strip the param
  useEffect(() => {
    if (pwaParam && !hasStrippedPwaParam.current) {
      setShowPWAInstallModal(true);
      hasStrippedPwaParam.current = true;
      // Strip the ?pwa param from the URL without closing the modal
      navigate({ to: "/", search: {}, replace: true });
    }
  }, [pwaParam, navigate]);

  // Use TanStack DB live query - always subscribe to the collection
  // This ensures mutations work immediately without needing to refresh
  const {
    data: userApps,
    isLoading,
    isError,
  } = useLiveQuery((q) => q.from({ userApp: userAppsCollection }));

  if (
    !session.isPending &&
    session.data?.user &&
    !session.data.session.activeOrganizationId
  ) {
    return null;
  }

  return (
    <div className="bg-base-100 h-full flex flex-col">
      <Header email={session.data?.user.email} />
      <div className="flex-1 min-h-0 animate-fade-in">
        <div className="max-w-4xl mx-auto px-4 py-6 h-full flex flex-col">
          <div className="space-y-6">
            <div className="flex justify-between items-start w-full">
              <div>
                <h2 className="text-2xl font-bold">Gateway</h2>
                <p className="text-base-content/70 mt-2">Access your apps</p>
              </div>
              {userCanManageApps && (
                <Link
                  to="/admin/apps"
                  className="btn btn-primary hidden sm:flex"
                >
                  <Settings className="w-4 h-4" />
                  Manage Apps
                </Link>
              )}
            </div>

            <OnboardingBanner />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto pt-4 scrollbar-stable scrollbar-hidden-mobile">
            {isError && (
              <div className="text-center py-8">
                <p className="text-error">
                  Failed to load apps. Please try again.
                </p>
              </div>
            )}

            {!isLoading && userApps && userApps.length > 0 && (
              <ul className="w-full space-y-3">
                {userApps.map((app) => (
                  <AppListItem key={app.id} app={app} />
                ))}
              </ul>
            )}

            {!isLoading && userApps && userApps.length === 0 && (
              <div className="text-center py-8">
                <p className="text-base-content/70">
                  {userCanManageApps
                    ? "No apps yet. Deploy your first app with the everyapp CLI to get started!"
                    : "No apps available. Contact your administrator to get access."}
                </p>
                {userCanManageApps && (
                  <Link to="/admin/apps" className="btn btn-primary mt-4">
                    <Settings className="w-4 h-4" />
                    Manage Apps
                  </Link>
                )}
              </div>
            )}
          </div>

          <PWAInstallModal
            open={showPWAInstallModal}
            onClose={() => setShowPWAInstallModal(false)}
          />
        </div>
      </div>
    </div>
  );
}
