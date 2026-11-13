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
import { Button } from "@/client/components/ui/button";
import { authClient } from "@/client/auth-client";
import { namesText } from "@/client/lib/oauthProviders";

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

/** "All apps", or the apps by name. */
function appsText(apps: McpConnection["apps"]): string {
  if (apps === "all") return "All apps";
  return apps.length > 0 ? namesText(apps) : "No apps";
}

/**
 * An agent's row: who it is, what it can reach in one line (which apps,
 * and whether it can change things), and when it last did. The
 * organization is a column only for someone with agents in several.
 */
function agentColumns({
  withOrganization,
  ...actions
}: {
  withOrganization: boolean;
  onRevoke: (connection: McpConnection) => void;
  isRevoking: boolean;
}): ColumnDef<McpConnection>[] {
  return [
    clientColumn("Agent"),
    ...(withOrganization ? [organizationColumn] : []),
    {
      id: "access",
      header: "Access",
      enableSorting: false,
      meta: { cellClassName: "max-w-[360px] truncate" },
      cell: ({ row: { original: connection } }) => (
        <>
          {appsText(connection.apps)}
          <span className="text-muted-foreground">
            {" · "}
            {connection.access === "write" ? "Read and write" : "Read only"}
          </span>
        </>
      ),
    },
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
  const withOrganization = spansOrganizations(agents);
  const columns = useMemo(
    () =>
      agentColumns({
        withOrganization,
        onRevoke: setRevoking,
        isRevoking: revokeMutation.isPending,
      }),
    [withOrganization, revokeMutation.isPending],
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
