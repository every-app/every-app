import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BadgeCheck, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { Header } from "@/client/components/Header";
import { domainCoversRedirect } from "@/client/components/oauth/clientSite";
import { useSession } from "@/client/hooks/useSession";
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
export const Route = createFileRoute("/settings/connections")({
  component: ConnectionsPage,
});

const CONNECTIONS_KEY = ["settings", "mcpConnections"];

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "never";
}

function ConnectionsPage() {
  const session = useSession();
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

  const handleRevoke = async (connectionId: string, clientName: string) => {
    const confirmed = window.confirm(
      `Revoke ${clientName}? It loses access on its next request, and has to be connected again to use your apps.`,
    );
    if (!confirmed) return;
    await revokeMutation.mutateAsync({ data: { connectionId } });
  };

  const connections = connectionsQuery.data?.connections ?? [];

  return (
    <div className="min-h-screen bg-base-100">
      <Header email={session.data?.user.email} />
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">Connected AI apps</h1>
            <p className="text-base-content/70 mt-1">
              AI apps you allowed to use your apps through this gateway's
              connector.
            </p>
          </div>
          <PlugZap className="w-5 h-5 text-base-content/50" />
        </div>

        {connectionsQuery.isError && (
          <div className="alert alert-error">
            <span>Failed to load your connections.</span>
          </div>
        )}

        {connectionsQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <span className="loading loading-spinner loading-lg"></span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Organization</th>
                  <th>Apps</th>
                  <th>Access</th>
                  <th>Connected</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {connections.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 opacity-60">
                      No connected AI apps.
                    </td>
                  </tr>
                ) : (
                  connections.map((connection) => (
                    <tr key={connection.id}>
                      <td>
                        <div className="font-medium">
                          {connection.clientName}
                        </div>
                        <div className="text-xs opacity-60 flex items-center gap-1">
                          {connection.clientDomain &&
                          domainCoversRedirect(
                            connection.clientDomain,
                            connection.redirectHost,
                          ) ? (
                            <>
                              <BadgeCheck className="h-3 w-3 text-success" />
                              {connection.clientDomain}
                            </>
                          ) : (
                            <>
                              {connection.clientDomain ?? "unverified"} · sends
                              to {connection.redirectHost}
                            </>
                          )}
                        </div>
                      </td>
                      <td>{connection.organizationName}</td>
                      <td>
                        {connection.apps === "all"
                          ? "All apps"
                          : connection.apps.join(", ") || "None"}
                      </td>
                      <td>
                        {connection.access === "write"
                          ? "Read & write"
                          : "Read only"}
                      </td>
                      <td>{formatDate(connection.createdAt)}</td>
                      <td>{formatDate(connection.lastUsedAt)}</td>
                      <td className="text-right">
                        <button
                          className="btn btn-sm btn-error btn-outline"
                          onClick={() =>
                            handleRevoke(connection.id, connection.clientName)
                          }
                          disabled={revokeMutation.isPending}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
