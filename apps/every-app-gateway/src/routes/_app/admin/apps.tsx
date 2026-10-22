import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import { Download } from "lucide-react";
import { adminAppsCollection } from "@/client/tanstack-db";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { AppsTable } from "@/client/components/admin/AppsTable";
import { EditAppModal } from "@/client/components/admin/EditAppModal";
import { DeleteAppModal } from "@/client/components/admin/DeleteAppModal";
import { ManageAppAccessModal } from "@/client/components/admin/ManageAppAccessModal";
import { Button } from "@/client/components/ui/button";
import { useAppInstallAvailable } from "@/client/app-install";
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

  const {
    data: apps,
    isError,
    isLoading,
  } = useLiveQuery((q) => q.from({ app: adminAppsCollection }));

  const confirmDelete = (app: AppWithAccessCount) => {
    adminAppsCollection.delete(app.id);
    setDeletingApp(null);
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Apps"
        hint={
          canInstall
            ? "Manage the app catalog and user access. Apps are added by installing them from GitHub or deploying them with the everyapp CLI."
            : "Manage the app catalog and user access. Apps are added by deploying them with the everyapp CLI."
        }
        action={
          canInstall ? (
            <Button nativeButton={false} render={<Link to="/install" />}>
              <Download />
              Install app
            </Button>
          ) : undefined
        }
      />

      <AppsTable
        apps={apps}
        isLoading={isLoading}
        error={
          isError ? (
            <ErrorState
              title="Failed to load apps"
              message="Please try again."
            />
          ) : undefined
        }
        onManageAccess={setAccessApp}
        onEdit={setEditingApp}
        onDelete={setDeletingApp}
        isOwner={isOwner}
      />

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
