import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useSession } from "@/client/hooks/useSession";
import { userAppsCollection } from "@/client/tanstack-db";
import { useState, useEffect } from "react";
import { Code } from "lucide-react";
import { AddCustomAppModal } from "@/client/components/AddCustomAppModal";
import { EditAppModal } from "@/client/components/EditAppModal";
import { DeleteAppModal } from "@/client/components/DeleteAppModal";
import { OnboardingBanner } from "@/client/components/onboarding/OnboardingBanner";
import { AppListItem, DevAppListItem } from "@/client/components/AppListItem";
import type { UserApp } from "@/types/user-app";
import { Header } from "@/client/components/Header";
export const Route = createFileRoute("/")({
  component: App,
});

const SHOW_DEV_URLS_KEY = "gateway-show-dev-urls";

function useShowDevUrls() {
  const [showDevUrls, setShowDevUrls] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(SHOW_DEV_URLS_KEY);
    return stored === null ? true : stored === "true";
  });

  useEffect(() => {
    localStorage.setItem(SHOW_DEV_URLS_KEY, String(showDevUrls));
  }, [showDevUrls]);

  return [showDevUrls, setShowDevUrls] as const;
}

function App() {
  const session = useSession();
  const [showAddCustomAppModal, setShowAddCustomAppModal] = useState(false);
  const [showEditAppModal, setShowEditAppModal] = useState(false);
  const [showDeleteAppModal, setShowDeleteAppModal] = useState(false);
  const [selectedApp, setSelectedApp] = useState<UserApp | null>(null);
  const [showDevUrls, setShowDevUrls] = useShowDevUrls();
  const navigate = useNavigate();

  // Use TanStack DB live query - always subscribe to the collection
  // This ensures mutations work immediately without needing to refresh
  const {
    data: userApps,
    isLoading,
    isError,
  } = useLiveQuery((q) => q.from({ userApp: userAppsCollection }));

  const hasAnyDevUrls = userApps?.some((app) => app.devUrl) ?? false;

  return (
    <div className="bg-base-100 h-screen flex flex-col overflow-y-auto">
      <Header email={session.data?.user.email} role={session.data?.user.role} />
      <div className="flex-1">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <div className="space-y-6">
            {isError && (
              <div className="text-center py-8">
                <p className="text-error">
                  Failed to load apps. Please try again.
                </p>
              </div>
            )}

            <div className="flex justify-between items-start w-full">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-bold">Gateway</h2>
                  {hasAnyDevUrls && (
                    <label className="hidden sm:flex items-center gap-1.5 cursor-pointer">
                      <Code className="w-4 h-4 text-base-content/50" />
                      <input
                        type="checkbox"
                        className="toggle toggle-xs toggle-primary"
                        checked={showDevUrls}
                        onChange={(e) => setShowDevUrls(e.target.checked)}
                      />
                    </label>
                  )}
                </div>
                <p className="text-base-content/70 mt-2">
                  Manage and access your apps
                </p>
              </div>
              <button
                className="btn btn-primary hidden sm:flex"
                onClick={() => setShowAddCustomAppModal(true)}
              >
                Add App
              </button>
            </div>

            <OnboardingBanner />

            {!isLoading && userApps && userApps.length > 0 && (
              <div className="w-full mt-4 space-y-3">
                {userApps.map((app) => (
                  <ul key={app.id} className="space-y-2">
                    <AppListItem
                      app={app}
                      onNavigate={() => navigate({ to: `/apps/${app.appId}` })}
                      onEdit={() => {
                        setSelectedApp(app);
                        setShowEditAppModal(true);
                      }}
                      onDelete={() => {
                        setSelectedApp(app);
                        setShowDeleteAppModal(true);
                      }}
                    />
                    {showDevUrls && app.devUrl && (
                      <div className="hidden sm:block">
                        <DevAppListItem
                          app={app}
                          onNavigate={() =>
                            navigate({
                              to: `/apps/${app.appId}/dev`,
                            })
                          }
                        />
                      </div>
                    )}
                  </ul>
                ))}
              </div>
            )}

            {!isLoading && userApps && userApps.length === 0 && (
              <div className="text-center py-8">
                <p className="text-base-content/70">
                  No apps installed yet. Add your first app to get started!
                </p>
              </div>
            )}

            <AddCustomAppModal
              open={showAddCustomAppModal}
              onOpenChange={setShowAddCustomAppModal}
            />
            <EditAppModal
              open={showEditAppModal}
              onOpenChange={setShowEditAppModal}
              app={selectedApp}
            />
            <DeleteAppModal
              open={showDeleteAppModal}
              onOpenChange={setShowDeleteAppModal}
              app={selectedApp}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
