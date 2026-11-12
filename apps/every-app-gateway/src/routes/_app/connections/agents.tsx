import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Unplug } from "lucide-react";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import {
  ConnectAgentDialog,
  ConnectAgentDocsLink,
  ConnectAgentSteps,
} from "@/client/components/ConnectAgent";
import { ErrorState } from "@/client/components/ErrorState";
import {
  clientColumn,
  createdAtColumn,
  isNative,
  lastUsedColumn,
  mcpConnectionSearchText,
  type McpConnection,
  organizationColumn,
  revokeColumn,
  useMcpConnections,
  useRevokeMcpConnection,
} from "@/client/components/McpConnections";
import { SettingsSection } from "@/client/components/SettingsLayout";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { useTableSearch } from "@/client/components/table/useTableSearch";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { authClient } from "@/client/auth-client";

/**
 * Your connections → Agents: the AI apps (Claude, ChatGPT, Cursor…) the
 * signed-in user connected to the gateway's /mcp, in every organization,
 * each with a way to revoke it. The steps to connect an agent take the
 * table's place until there is one, and are a dialog behind the heading's
 * button after that.
 */
export const Route = createFileRoute("/_app/connections/agents")({
  component: AgentsTab,
});

const AGENTS = {
  title: "Agents",
  hint: "Claude, ChatGPT and other AI apps that use your apps through this Gateway.",
};

function agentColumns(actions: {
  onRevoke: (connection: McpConnection) => void;
  isRevoking: boolean;
}): ColumnDef<McpConnection>[] {
  return [
    clientColumn("Agent"),
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
    revokeColumn({ icon: <Unplug />, label: "Revoke connection", ...actions }),
  ];
}

function AgentsTab() {
  const [revoking, setRevoking] = useState<McpConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  // The steps' tokens line: owners and admins are sent to
  // Manage workspace → Tokens, which refuses members.
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const connectionsQuery = useMcpConnections();
  const revokeMutation = useRevokeMcpConnection("Connection revoked");

  const agents = useMemo(
    () =>
      (connectionsQuery.data?.connections ?? []).filter(
        (connection) => !isNative(connection),
      ),
    [connectionsQuery.data],
  );
  const columns = useMemo(
    () =>
      agentColumns({
        onRevoke: setRevoking,
        isRevoking: revokeMutation.isPending,
      }),
    [revokeMutation.isPending],
  );
  const search = useTableSearch(agents, mcpConnectionSearchText, "agents");
  const table = useDataTable({
    data: search.rows,
    columns,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });

  return (
    <>
      {connectionsQuery.isSuccess && agents.length === 0 ? (
        // With no agent yet the steps take the table's place, at a
        // reading width.
        <div className="max-w-2xl">
          <SettingsSection
            {...AGENTS}
            action={
              <span className="text-xs text-muted-foreground">
                <ConnectAgentDocsLink />
              </span>
            }
          >
            <div className="rounded-xl border border-border bg-card p-4">
              <ConnectAgentSteps role={activeMemberRole?.role} />
            </div>
          </SettingsSection>
        </div>
      ) : (
        <SettingsSection
          {...AGENTS}
          action={
            <Button onClick={() => setConnecting(true)}>
              <Plus data-icon="inline-start" />
              Connect an agent
            </Button>
          }
        >
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
            search={search.search}
            empty={{ title: "No agents connected yet" }}
          />
        </SettingsSection>
      )}

      {connecting ? (
        <ConnectAgentDialog
          role={activeMemberRole?.role}
          connectionsLink={false}
          onClose={() => setConnecting(false)}
        />
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.clientName}?`}
          confirmLabel="Revoke connection"
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
          It loses access on its next request.
        </ConfirmDialog>
      ) : null}
    </>
  );
}
