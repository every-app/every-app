import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useSession } from "@/client/hooks/useSession";
import { userAppsCollection } from "@/client/tanstack-db";
import { useState } from "react";
import { AddCustomAppModal } from "@/client/components/AddCustomAppModal";
import { EditAppModal } from "@/client/components/EditAppModal";
import { DeleteAppModal } from "@/client/components/DeleteAppModal";
import { OnboardingBanner } from "@/client/components/onboarding/OnboardingBanner";
import { AppListItem } from "@/client/components/AppListItem";
import type { UserApp } from "@/types/user-app";
import { Header } from "@/client/components/Header";
export const Route = createFileRoute("/")({
  component: App,
});

function App() {
  const session = useSession();
  const [showAddCustomAppModal, setShowAddCustomAppModal] = useState(false);
  const [showEditAppModal, setShowEditAppModal] = useState(false);
  const [showDeleteAppModal, setShowDeleteAppModal] = useState(false);
  const [selectedApp, setSelectedApp] = useState<UserApp | null>(null);
  const navigate = useNavigate();

  // Use TanStack DB live query - always subscribe to the collection
  // This ensures mutations work immediately without needing to refresh
  const {
    data: userApps,
    isLoading,
    isError,
  } = useLiveQuery((q) => q.from({ userApp: userAppsCollection }));

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
                <h2 className="text-2xl font-bold">Gateway</h2>
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
              <ul className="w-full mt-4 space-y-3">
                {userApps.map((app) => (
                  <AppListItem
                    key={app.id}
                    app={app}
                    onNavigate={() => navigate({ to: `/apps/${app.appId}` })}
                    onNavigateDev={() =>
                      navigate({
                        to: `/apps/${app.appId}`,
                        search: { dev: true },
                      })
                    }
                    onEdit={() => {
                      setSelectedApp(app);
                      setShowEditAppModal(true);
                    }}
                    onDelete={() => {
                      setSelectedApp(app);
                      setShowDeleteAppModal(true);
                    }}
                  />
                ))}
              </ul>
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
