import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { LogOut } from "lucide-react";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import {
  clientColumn,
  createdAtColumn,
  isNative,
  lastUsedColumn,
  type McpConnection,
  organizationColumn,
  revokeColumn,
  useMcpConnections,
  useRevokeMcpConnection,
} from "@/client/components/McpConnections";
import { SettingsSection } from "@/client/components/SettingsLayout";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";

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
  const columns = useMemo(
    () =>
      deviceColumns({
        onRevoke: setSigningOut,
        isRevoking: revokeMutation.isPending,
      }),
    [revokeMutation.isPending],
  );
  const table = useDataTable({
    data: devices,
    columns,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });

  if (devices.length === 0) return null;

  return (
    <>
      <SettingsSection
        title="Apps on your devices"
        hint="Desktop and phone apps you've signed in to, and local projects linked with everyapp dev."
      >
        <DataTable table={table} empty={{ title: "No apps on your devices" }} />
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
          It loses access on its next request, and you sign in on the device
          again to use it.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** A native app's row: the app on the device, and the one app it opens. */
function deviceColumns(actions: {
  onRevoke: (connection: McpConnection) => void;
  isRevoking: boolean;
}): ColumnDef<McpConnection>[] {
  return [
    clientColumn("App"),
    {
      id: "opens",
      header: "Opens",
      enableSorting: false,
      meta: { cellClassName: "max-w-[240px]" },
      cell: ({ row: { original: connection } }) =>
        connection.app ? (
          <>
            <p className="truncate">{connection.app.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {connection.kind === "dev"
                ? "Linked dev: its providers and services, as you"
                : connection.app.hostname}
            </p>
          </>
        ) : (
          // The app is gone; the row is revoked with it.
          <span className="text-muted-foreground">Removed app</span>
        ),
    },
    organizationColumn,
    createdAtColumn("Signed in"),
    lastUsedColumn,
    revokeColumn({ icon: <LogOut />, label: "Sign out", ...actions }),
  ];
}
