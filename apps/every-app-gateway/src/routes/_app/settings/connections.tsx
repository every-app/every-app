import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { BadgeCheck, LogOut, Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import {
  ConnectAgentDocsLink,
  ConnectAgentSteps,
} from "@/client/components/ConnectAgent";
import { ErrorState } from "@/client/components/ErrorState";
import {
  Page,
  PageHeader,
  SectionHeader,
} from "@/client/components/PageHeader";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { domainCoversRedirect } from "@/client/components/oauth/clientSite";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { authClient } from "@/client/auth-client";
import { CONNECT_AGENT_COPY } from "@/client/lib/connectAgentCopy";
import {
  listMyMcpConnections,
  revokeMyMcpConnection,
} from "@/serverFunctions/mcpConnections";

/**
 * The AI apps (Claude, ChatGPT, Cursor…) the signed-in user connected to the
 * gateway's /mcp, in every organization, and under "Apps on your devices"
 * the native apps they signed in to one app with
 * (docs/design/native-sign-in.md), each with a way to revoke it. Revoking
 * stops the app on its next request. Only the person's own connections are
 * listed, and only they can revoke them.
 */
export const Route = createFileRoute("/_app/settings/connections")({
  component: ConnectionsPage,
});

const CONNECTIONS_KEY = ["settings", "mcpConnections"];

type Connection = Awaited<
  ReturnType<typeof listMyMcpConnections>
>["connections"][number];

function isNative(connection: Connection): boolean {
  return connection.kind === "native" || connection.kind === "dev";
}

/** The client's name, and its verified domain or where it sends access. */
function ClientCell({ connection }: { connection: Connection }) {
  return (
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
            {connection.clientDomain ?? "Unverified"} · sends to{" "}
            {connection.redirectHost}
          </span>
        )}
      </p>
    </>
  );
}

function createdAtColumn(label: string): ColumnDef<Connection> {
  return {
    accessorKey: "createdAt",
    header: ({ column }) => <SortableHeader column={column} label={label} />,
    meta: { label, cellClassName: "text-xs text-muted-foreground" },
    cell: ({ row: { original: connection } }) => (
      <DateCell value={connection.createdAt} />
    ),
  };
}

const lastUsedColumn: ColumnDef<Connection> = {
  id: "lastUsedAt",
  // Never used sorts as the oldest.
  accessorFn: (connection) => dateSortValue(connection.lastUsedAt, 0),
  header: ({ column }) => <SortableHeader column={column} label="Last used" />,
  meta: {
    label: "Last used",
    cellClassName: "text-xs text-muted-foreground",
  },
  cell: ({ row: { original: connection } }) => (
    <DateCell value={connection.lastUsedAt} />
  ),
};

const organizationColumn: ColumnDef<Connection> = {
  accessorKey: "organizationName",
  header: ({ column }) => (
    <SortableHeader column={column} label="Organization" />
  ),
  meta: { label: "Organization" },
};

function actionsColumn({
  onRevoke,
  isRevoking,
}: {
  onRevoke: (connection: Connection) => void;
  isRevoking: boolean;
}): ColumnDef<Connection> {
  return {
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
          {isNative(connection) ? <LogOut /> : <Unplug />}
          {isNative(connection) ? "Sign out" : "Revoke connection"}
        </DropdownMenuItem>
      </RowActionsMenu>
    ),
  };
}

/** A native app's row: the app on the device, and the one app it opens. */
function deviceColumns(actions: {
  onRevoke: (connection: Connection) => void;
  isRevoking: boolean;
}): ColumnDef<Connection>[] {
  return [
    {
      id: "client",
      accessorFn: (connection) => connection.clientName,
      header: ({ column }) => <SortableHeader column={column} label="App" />,
      meta: { label: "App", cellClassName: "max-w-[280px]" },
      cell: ({ row: { original: connection } }) => (
        <ClientCell connection={connection} />
      ),
    },
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
    actionsColumn(actions),
  ];
}

function connectionColumns(actions: {
  onRevoke: (connection: Connection) => void;
  isRevoking: boolean;
}): ColumnDef<Connection>[] {
  return [
    {
      id: "app",
      accessorFn: (connection) => connection.clientName,
      header: ({ column }) => <SortableHeader column={column} label="App" />,
      meta: { label: "App", cellClassName: "max-w-[280px]" },
      cell: ({ row: { original: connection } }) => (
        <ClientCell connection={connection} />
      ),
    },
    organizationColumn,
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
    createdAtColumn("Connected"),
    lastUsedColumn,
    actionsColumn(actions),
  ];
}

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<Connection | null>(null);
  // The steps' tokens line: owners and admins are sent to
  // Manage workspace → Tokens, which refuses members.
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
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

  const connections: Connection[] | undefined =
    connectionsQuery.data?.connections;
  const agents = useMemo(
    () => (connections ?? []).filter((connection) => !isNative(connection)),
    [connections],
  );
  const devices = useMemo(
    () => (connections ?? []).filter(isNative),
    [connections],
  );
  const actions = useMemo(
    () => ({ onRevoke: setRevoking, isRevoking: revokeMutation.isPending }),
    [revokeMutation.isPending],
  );
  const columns = useMemo(() => connectionColumns(actions), [actions]);
  const devicesColumns = useMemo(() => deviceColumns(actions), [actions]);
  const table = useDataTable({
    data: agents,
    columns,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });
  const devicesTable = useDataTable({
    data: devices,
    columns: devicesColumns,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });

  return (
    <Page>
      <PageHeader title="AI connections" />

      {/* How to connect one, before and after the first: the same steps
          as the sidebar's Connect your agent. */}
      <section
        aria-label={CONNECT_AGENT_COPY.title}
        className="max-w-2xl space-y-3"
      >
        <SectionHeader
          title={CONNECT_AGENT_COPY.title}
          action={
            <span className="text-xs text-muted-foreground">
              <ConnectAgentDocsLink />
            </span>
          }
        />
        <div className="rounded-xl border border-border bg-card p-4">
          <ConnectAgentSteps role={activeMemberRole?.role} />
        </div>
      </section>

      <DataTable
        table={table}
        isLoading={connectionsQuery.isLoading}
        error={
          connectionsQuery.isError ? (
            <ErrorState
              message="Couldn't load your connections."
              onRetry={() => void connectionsQuery.refetch()}
              isRetrying={connectionsQuery.isFetching}
            />
          ) : undefined
        }
        empty={{
          title: "No AI connections yet",
          description: "Agents you connect show here, to revoke any time.",
        }}
      />

      {/* Shown once there is one: most people never sign a native app in. */}
      {devices.length > 0 ? (
        <section aria-label="Apps on your devices" className="space-y-3">
          <SectionHeader
            title="Apps on your devices"
            hint="Desktop and phone apps you signed in to one app with, and everyapp dev linked to an app from your computer. Each can do there what you can."
          />
          <DataTable
            table={devicesTable}
            empty={{ title: "No apps on your devices" }}
          />
        </section>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title={
            isNative(revoking)
              ? `Sign ${revoking.clientName} out?`
              : `Revoke ${revoking.clientName}?`
          }
          confirmLabel={isNative(revoking) ? "Sign out" : "Revoke connection"}
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
          {isNative(revoking)
            ? "It loses access on its next request, and you sign in on the device again to use it."
            : "It loses access on its next request."}
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
