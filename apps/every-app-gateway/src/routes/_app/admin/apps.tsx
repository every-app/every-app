import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import { Download, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  adminAppsCollection,
  useQueryFailed,
  userAppsCollection,
} from "@/client/tanstack-db";
import { AppSetupDialog } from "@/client/components/AppSetupDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { McpAppDialog } from "@/client/components/McpAppDialog";
import { SectionHeader } from "@/client/components/PageHeader";
import { AppsTable } from "@/client/components/admin/AppsTable";
import { EditAppModal } from "@/client/components/admin/EditAppModal";
import { DeleteAppModal } from "@/client/components/admin/DeleteAppModal";
import { ManageAppAccessModal } from "@/client/components/admin/ManageAppAccessModal";
import { McpAppEditDialog } from "@/client/components/admin/McpAppEditDialog";
import { AddAppDialog } from "@/client/components/onboarding/AddAppDialog";
import { Button } from "@/client/components/ui/button";
import { useAppInstallAvailable } from "@/client/app-install";
import { getRuleErrorMessage } from "@/client/errors";
import { useSetupDialog } from "@/client/hooks/useSetupDialog";
import { isMcpApp, isRemoteMcpApp } from "@/client/lib/appStatus";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { removeMcpApp, setMcpAppStatus } from "@/serverFunctions/mcpApps";
import type { AppWithAccessCount } from "@/types/app";
import { authClient } from "@/client/auth-client";

export const Route = createFileRoute("/_app/admin/apps")({
  component: AppsPage,
});

/** The admin list, from the server (not the query cache). */
function refetchApps() {
  return adminAppsCollection.utils.refetch();
}

/** After an MCP app changed: this list and the launcher's read it again. */
function refetchAppLists() {
  void adminAppsCollection.utils.refetch();
  void userAppsCollection.utils.refetch();
}

/** Turn an MCP app off when it is on, on when it is off (the row menu). */
async function toggleMcpStatus(app: AppWithAccessCount) {
  const on = app.status === "active";
  try {
    await setMcpAppStatus({
      data: { id: app.id, status: on ? "disabled" : "active" },
    });
    toast.success(
      on
        ? MCP_APP_COPY.menu.turnedOff(app.name)
        : MCP_APP_COPY.menu.turnedOn(app.name),
    );
    refetchAppLists();
  } catch (error) {
    toast.error(getRuleErrorMessage(error, MCP_APP_COPY.menu.statusFailed));
  }
}

function AppsPage() {
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const isAdmin =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  // Hosted deployer or a configured self-hosted browser deployer.
  const { data: canInstall } = useAppInstallAvailable(isAdmin);
  // Each dialog renders only while its app is set. The setters are stable, so
  // the table's columns are too.
  const [editingApp, setEditingApp] = useState<AppWithAccessCount | null>(null);
  const [deletingApp, setDeletingApp] = useState<AppWithAccessCount | null>(
    null,
  );
  const [accessApp, setAccessApp] = useState<AppWithAccessCount | null>(null);
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
  // The setup dialog's app, read from the live list: it closes by itself
  // once the app is ready. `openSetup` is stable, like the setters.
  const {
    app: setupApp,
    open: openSetup,
    close: closeSetup,
  } = useSetupDialog(apps, refetchApps);

  // Removing an MCP app runs its own server function (the tombstone, with
  // the snapshot and what its server listed); the dialog waits for it.
  const [removing, setRemoving] = useState(false);
  const confirmDelete = (app: AppWithAccessCount) => {
    if (!isMcpApp(app)) {
      adminAppsCollection.delete(app.id);
      setDeletingApp(null);
      return;
    }
    setRemoving(true);
    void removeMcpApp({ data: { id: app.id } })
      .then(
        () => {
          toast.success(MCP_APP_COPY.menu.removed(app.name));
          refetchAppLists();
          setDeletingApp(null);
        },
        (error: unknown) =>
          toast.error(
            getRuleErrorMessage(error, MCP_APP_COPY.menu.removeFailed),
          ),
      )
      .finally(() => setRemoving(false));
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
        onSetup={openSetup}
        onUseMcp={setMcpApp}
        onManageAccess={setAccessApp}
        onEdit={setEditingApp}
        onDelete={setDeletingApp}
        onToggleMcpStatus={toggleMcpStatus}
        onAddApp={() => setAddingApp(true)}
        isAdmin={isAdmin}
      />

      {addingApp ? (
        <AddAppDialog
          canRun={isAdmin}
          onClose={() => setAddingApp(false)}
          onMcpAppAdded={refetchAppLists}
        />
      ) : null}

      {setupApp ? (
        <AppSetupDialog
          name={setupApp.name}
          setup={setupApp.setup}
          // Another organization's shared app is listed, never set up here:
          // the dialog says who does, and leaves out what else could be set.
          canRun={!setupApp.readOnly}
          onClose={closeSetup}
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
        // A remote MCP server has its own dialog (its credential, status,
        // tools); every other app, a built-in MCP app included, the modal.
        isRemoteMcpApp(editingApp) ? (
          <McpAppEditDialog
            app={editingApp}
            onClose={() => setEditingApp(null)}
            onChanged={refetchAppLists}
          />
        ) : (
          <EditAppModal app={editingApp} onClose={() => setEditingApp(null)} />
        )
      ) : null}

      {isAdmin && deletingApp ? (
        <DeleteAppModal
          app={deletingApp}
          pending={removing}
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
