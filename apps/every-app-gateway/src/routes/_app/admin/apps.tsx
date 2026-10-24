import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import { Download, Plus } from "lucide-react";
import { adminAppsCollection, useQueryFailed } from "@/client/tanstack-db";
import { AppSetupDialog } from "@/client/components/AppSetupDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { McpAppDialog } from "@/client/components/McpAppDialog";
import { SectionHeader } from "@/client/components/PageHeader";
import { AppsTable } from "@/client/components/admin/AppsTable";
import { EditAppModal } from "@/client/components/admin/EditAppModal";
import { DeleteAppModal } from "@/client/components/admin/DeleteAppModal";
import { ManageAppAccessModal } from "@/client/components/admin/ManageAppAccessModal";
import { AddAppDialog } from "@/client/components/onboarding/AddAppDialog";
import { Button } from "@/client/components/ui/button";
import { useAppInstallAvailable } from "@/client/app-install";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";
import type { AppWithAccessCount } from "@/types/app";
import { authClient } from "@/client/auth-client";

export const Route = createFileRoute("/_app/admin/apps")({
  component: AppsPage,
});

function AppsPage() {
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const isOwner = activeMemberRole?.role === "owner";
  const isAdmin = isOwner || activeMemberRole?.role === "admin";
  // Hosted deployer or a configured self-hosted browser deployer.
  const { data: canInstall } = useAppInstallAvailable(isAdmin);
  // Each dialog renders only while its app is set. The setters are stable, so
  // the table's columns are too.
  const [editingApp, setEditingApp] = useState<AppWithAccessCount | null>(null);
  const [deletingApp, setDeletingApp] = useState<AppWithAccessCount | null>(
    null,
  );
  const [accessApp, setAccessApp] = useState<AppWithAccessCount | null>(null);
  const [setupApp, setSetupApp] = useState<AppWithAccessCount | null>(null);
  // The four apps and Build your own, once the home no longer shows them.
  const [addingApp, setAddingApp] = useState(false);
  const [mcpApp, setMcpApp] = useState<AppWithAccessCount | null>(null);

  const {
    data: apps,
    isError: isCollectionError,
    isLoading,
  } = useLiveQuery((q) => q.from({ app: adminAppsCollection }));
  // A failed fetch leaves the collection "ready" and empty: ask the query.
  const isError = isCollectionError || useQueryFailed(["admin", "apps"]);

  const confirmDelete = (app: AppWithAccessCount) => {
    adminAppsCollection.delete(app.id);
    setDeletingApp(null);
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Apps"
        action={
          <div className="flex items-center gap-2">
            {canInstall ? (
              <Button nativeButton={false} render={<Link to="/install" />}>
                <Download />
                Install app
              </Button>
            ) : null}
            <Button
              variant="outline"
              aria-haspopup="dialog"
              onClick={() => setAddingApp(true)}
            >
              <Plus />
              {FIRST_SCREEN.addApp.button}
            </Button>
          </div>
        }
      />

      <AppsTable
        apps={apps}
        isLoading={isLoading}
        error={
          isError ? (
            <ErrorState
              message="Couldn't load apps."
              onRetry={() => void adminAppsCollection.utils.refetch()}
            />
          ) : undefined
        }
        onSetup={setSetupApp}
        onUseMcp={setMcpApp}
        onManageAccess={setAccessApp}
        onEdit={setEditingApp}
        onDelete={setDeletingApp}
        onAddApp={() => setAddingApp(true)}
        isOwner={isOwner}
      />

      {addingApp ? (
        <AddAppDialog canRun={isAdmin} onClose={() => setAddingApp(false)} />
      ) : null}

      {setupApp?.setup ? (
        <AppSetupDialog
          name={setupApp.name}
          setup={setupApp.setup}
          // Another organization's shared app is listed, never set up here:
          // the dialog says who does, and leaves out what else could be set.
          canRun={!setupApp.readOnly}
          onClose={() => setSetupApp(null)}
        />
      ) : null}

      {mcpApp ? (
        <McpAppDialog
          name={mcpApp.name}
          appId={mcpApp.appId}
          onClose={() => setMcpApp(null)}
        />
      ) : null}

      {editingApp ? (
        <EditAppModal app={editingApp} onClose={() => setEditingApp(null)} />
      ) : null}

      {isOwner && deletingApp ? (
        <DeleteAppModal
          app={deletingApp}
          onClose={() => setDeletingApp(null)}
          onConfirm={() => confirmDelete(deletingApp)}
        />
      ) : null}

      {accessApp ? (
        <ManageAppAccessModal
          app={accessApp}
          onClose={() => setAccessApp(null)}
        />
      ) : null}
    </div>
  );
}
