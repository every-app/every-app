import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { LogOut } from "lucide-react";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import {
  clientColumn,
  isNative,
  lastUsedColumn,
  mcpConnectionSearchText,
  type McpConnection,
  organizationColumn,
  revokeColumn,
  spansOrganizations,
  useMcpConnections,
  useRevokeMcpConnection,
} from "@/client/components/McpConnections";
import { SettingsSection } from "@/client/components/SettingsLayout";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { useTableSearch } from "@/client/components/table/useTableSearch";

/**
 * Apps on your devices: the native apps the signed-in person signed in to
 * one app with (docs/design/native-sign-in.md), and the local projects
 * linked with `everyapp dev`, each with Sign out. Shown once there is one:
 * most people never sign a native app in.
 */
export function DeviceApps() {
  const [signingOut, setSigningOut] = useState<McpConnection | null>(null);
  const connectionsQuery = useMcpConnections();
  const revokeMutation = useRevokeMcpConnection("Signed out");

  const devices = useMemo(
    () => (connectionsQuery.data?.connections ?? []).filter(isNative),
    [connectionsQuery.data],
  );
  const withOrganization = spansOrganizations(devices);
  const columns = useMemo(
    () =>
      deviceColumns({
        withOrganization,
        onRevoke: setSigningOut,
        isRevoking: revokeMutation.isPending,
      }),
    [withOrganization, revokeMutation.isPending],
  );
  const search = useTableSearch(devices, mcpConnectionSearchText, "apps");
  const table = useDataTable({
    data: search.rows,
    columns,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });

  if (devices.length === 0) return null;

  return (
    <>
      <SettingsSection title="Apps on your devices">
        <DataTable
          table={table}
          search={search.search}
          empty={{ title: "No apps on your devices" }}
        />
      </SettingsSection>

      {signingOut ? (
        <ConfirmDialog
          title={`Sign ${signingOut.clientName} out?`}
          confirmLabel="Sign out"
          destructive
          pending={revokeMutation.isPending}
          onClose={() => setSigningOut(null)}
          onConfirm={() =>
            revokeMutation.mutate(
              { data: { connectionId: signingOut.id } },
              { onSettled: () => setSigningOut(null) },
            )
          }
        >
          You'll sign in again on that device to use it.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/**
 * A native app's row: the app on the device, the one app it opens, and
 * when it was last used. Every one of them runs on the person's own
 * device, so the row doesn't say so; the organization is a column only
 * for someone signed in to several.
 */
function deviceColumns({
  withOrganization,
  ...actions
}: {
  withOrganization: boolean;
  onRevoke: (connection: McpConnection) => void;
  isRevoking: boolean;
}): ColumnDef<McpConnection>[] {
  return [
    clientColumn("App", { local: false }),
    {
      id: "opens",
      header: "Opens",
      enableSorting: false,
      meta: { cellClassName: "max-w-[360px] truncate" },
      cell: ({ row: { original: connection } }) =>
        connection.app ? (
          <>
            {connection.app.name}
            {connection.kind === "dev" ? (
              <span className="text-muted-foreground">
                {" · "}for local development
              </span>
            ) : null}
          </>
        ) : (
          // The app is gone; the row is revoked with it.
          <span className="text-muted-foreground">Removed app</span>
        ),
    },
    ...(withOrganization ? [organizationColumn] : []),
    lastUsedColumn,
    revokeColumn({ icon: <LogOut />, label: "Sign out", ...actions }),
  ];
}
