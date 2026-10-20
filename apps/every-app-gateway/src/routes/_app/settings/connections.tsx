import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { BadgeCheck, Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { PageHeader } from "@/client/components/PageHeader";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { domainCoversRedirect } from "@/client/components/oauth/clientSite";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { queryClient } from "@/client/tanstack-db";
import {
  listMyMcpConnections,
  revokeMyMcpConnection,
} from "@/serverFunctions/mcpConnections";

/**
 * The AI apps (Claude, ChatGPT, Cursor…) the signed-in user connected to the
 * gateway's /mcp, in every organization, with a way to revoke each. Revoking
 * stops the app on its next request.
 */
export const Route = createFileRoute("/_app/settings/connections")({
  component: ConnectionsPage,
});

const CONNECTIONS_KEY = ["settings", "mcpConnections"];

type Connection = Awaited<
  ReturnType<typeof listMyMcpConnections>
>["connections"][number];

function connectionColumns({
  onRevoke,
  isRevoking,
}: {
  onRevoke: (connection: Connection) => void;
  isRevoking: boolean;
}): ColumnDef<Connection>[] {
  return [
    {
      id: "app",
      accessorFn: (connection) => connection.clientName,
      header: ({ column }) => <SortableHeader column={column} label="App" />,
      meta: { cellClassName: "max-w-[280px]" },
      cell: ({ row: { original: connection } }) => (
        <>
          <p className="truncate font-medium">{connection.clientName}</p>
          <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {connection.clientDomain &&
            domainCoversRedirect(
              connection.clientDomain,
              connection.redirectHost,
            ) ? (
              <>
                <BadgeCheck className="size-3 shrink-0 text-success" />
                <span className="truncate">{connection.clientDomain}</span>
              </>
            ) : (
              <span className="truncate">
                {connection.clientDomain ?? "unverified"} · sends to{" "}
                {connection.redirectHost}
              </span>
            )}
          </p>
        </>
      ),
    },
    {
      accessorKey: "organizationName",
      header: ({ column }) => (
        <SortableHeader column={column} label="Organization" />
      ),
    },
    {
      id: "apps",
      header: "Apps",
      enableSorting: false,
      meta: { cellClassName: "max-w-[240px]" },
      cell: ({ row: { original: connection } }) =>
        connection.apps === "all"
          ? "All apps"
          : connection.apps.join(", ") || "None",
    },
    {
      accessorKey: "access",
      header: "Access",
      enableSorting: false,
      cell: ({ row: { original: connection } }) => (
        <Badge variant="secondary">
          {connection.access === "write" ? "Read & write" : "Read only"}
        </Badge>
      ),
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => (
        <SortableHeader column={column} label="Connected" />
      ),
      meta: { cellClassName: "text-xs text-muted-foreground" },
      cell: ({ row: { original: connection } }) => (
        <DateCell value={connection.createdAt} />
      ),
    },
    {
      id: "lastUsedAt",
      // Never used sorts as the oldest.
      accessorFn: (connection) => dateSortValue(connection.lastUsedAt, 0),
      header: ({ column }) => (
        <SortableHeader column={column} label="Last used" />
      ),
      meta: { cellClassName: "text-xs text-muted-foreground" },
      cell: ({ row: { original: connection } }) => (
        <DateCell value={connection.lastUsedAt} />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: connection } }) => (
        <RowActionsMenu label={`Actions for ${connection.clientName}`}>
          <DropdownMenuItem
            variant="destructive"
            disabled={isRevoking}
            onClick={() => onRevoke(connection)}
          >
            <Unplug />
            Revoke
          </DropdownMenuItem>
        </RowActionsMenu>
      ),
    },
  ];
}

function ConnectionsPage() {
  const [revoking, setRevoking] = useState<Connection | null>(null);
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => listMyMcpConnections(),
  });
  const revokeMutation = useMutation({
    mutationFn: revokeMyMcpConnection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success("Connection revoked");
    },
    onError: () => {
      toast.error("Failed to revoke the connection");
    },
  });

  const columns = useMemo(
    () =>
      connectionColumns({
        onRevoke: setRevoking,
        isRevoking: revokeMutation.isPending,
      }),
    [revokeMutation.isPending],
  );
  const table = useDataTable({
    data: connectionsQuery.data?.connections ?? [],
    columns,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });

  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          title="AI connections"
          description="Manage the AI assistants you have allowed to access your apps."
        />

        <DataTable
          table={table}
          isLoading={connectionsQuery.isLoading}
          error={
            connectionsQuery.isError ? (
              <ErrorState
                message="Failed to load your connections."
                onRetry={() => void connectionsQuery.refetch()}
                isRetrying={connectionsQuery.isFetching}
              />
            ) : undefined
          }
          empty={{
            title: "No AI connections yet",
            description:
              "When you allow an AI app such as Claude or ChatGPT to use your apps, it shows up here.",
          }}
        />

        {revoking ? (
          <ConfirmDialog
            title={`Revoke ${revoking.clientName}?`}
            confirmLabel="Revoke"
            destructive
            pending={revokeMutation.isPending}
            onClose={() => setRevoking(null)}
            onConfirm={() =>
              revokeMutation.mutate(
                { data: { connectionId: revoking.id } },
                { onSettled: () => setRevoking(null) },
              )
            }
          >
            It loses access on its next request, and has to be connected again
            to use your apps.
          </ConfirmDialog>
        ) : null}
      </div>
    </div>
  );
}
