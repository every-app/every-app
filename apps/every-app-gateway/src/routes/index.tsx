import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useSession } from "@/client/hooks/useSession";
import { userAppsCollection } from "@/client/tanstack-db";
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import { AddCustomAppModal } from "@/client/components/AddCustomAppModal";
import { EditAppModal } from "@/client/components/EditAppModal";
import { DeleteAppModal } from "@/client/components/DeleteAppModal";
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
  const [hoveredDropdownAppId, setHoveredDropdownAppId] = useState<
    string | null
  >(null);
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
      <Header email={session.data?.user.email} />
      <div className="flex-1">
        <div className="max-w-3xl mx-auto px-4 py-6">
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

            {!isLoading && userApps && userApps.length > 0 && (
              <ul className="w-full mt-4 space-y-3">
                {userApps.map((app) => {
                  const isDropdownHovered = hoveredDropdownAppId === app.id;
                  return (
                    <li
                      key={app.id}
                      className={`border border-base-content/20 rounded-lg bg-base-100 transition-all cursor-pointer ${
                        !isDropdownHovered
                          ? "hover:bg-base-200 hover:border-base-400 hover:shadow-md"
                          : ""
                      }`}
                      onClick={() => navigate({ to: `/apps/${app.appId}` })}
                    >
                      <div className="flex items-center justify-between p-4">
                        <div className="flex-1">
                          <div className="font-medium">{app.name}</div>
                          <div className="text-sm text-base-content/70">
                            {app.description}
                          </div>
                        </div>
                        <div
                          className="dropdown dropdown-end relative z-10 hidden sm:block"
                          onClick={(e) => e.stopPropagation()}
                          onMouseEnter={() => setHoveredDropdownAppId(app.id)}
                          onMouseLeave={() => setHoveredDropdownAppId(null)}
                        >
                          <button
                            tabIndex={0}
                            className="btn btn-ghost btn-sm btn-square"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                          <ul
                            tabIndex={0}
                            className="dropdown-content menu z-1 w-52"
                          >
                            <li>
                              <button
                                onClick={() => {
                                  setSelectedApp(app);
                                  setShowEditAppModal(true);
                                }}
                              >
                                Edit
                              </button>
                            </li>
                            <li>
                              <button
                                className="text-error"
                                onClick={() => {
                                  setSelectedApp(app);
                                  setShowDeleteAppModal(true);
                                }}
                              >
                                Delete
                              </button>
                            </li>
                          </ul>
                        </div>
                      </div>
                    </li>
                  );
                })}
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
