import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { Page, PageHeader } from "@/client/components/PageHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getRuleErrorMessage } from "@/client/errors";
import { scopesText } from "@/client/lib/oauthProviders";
import {
  disconnectConnection,
  listMyConnections,
} from "@/serverFunctions/connections";

/**
 * Settings → Connected accounts (docs/design/2026-11-oauth-simplify.md):
 * the OAuth accounts this person connected through the Gateway, one row
 * per connection, each one app's, with the scopes it holds and
 * Disconnect. People connect inside each app, so nothing here starts a
 * connect.
 */
export const Route = createFileRoute("/_app/settings/accounts")({
  component: AccountsPage,
});

const MY_CONNECTIONS_KEY = ["settings", "providerConnections"] as const;

type Connection = Awaited<
  ReturnType<typeof listMyConnections>
>["connections"][number];

function AccountsPage() {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);

  const connectionsQuery = useQuery({
    queryKey: MY_CONNECTIONS_KEY,
    queryFn: () => listMyConnections(),
  });
  const disconnectMutation = useMutation({
    mutationFn: disconnectConnection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MY_CONNECTIONS_KEY });
      toast.success("Disconnected");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to disconnect")),
  });

  const connections = connectionsQuery.data?.connections ?? [];

  return (
    <Page>
      <PageHeader
        title="Connected accounts"
        description="Accounts you've connected inside your apps, such as Gmail."
      />

      {connectionsQuery.isError ? (
        <ErrorState
          message="Couldn't load your connected accounts."
          onRetry={() => void connectionsQuery.refetch()}
          isRetrying={connectionsQuery.isFetching}
        />
      ) : connectionsQuery.isLoading ? (
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : connections.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No connected accounts yet. Connect one inside an app.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border"
          aria-label="Connected accounts"
        >
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">
                  {connection.providerName}
                  {connection.label ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {connection.label}
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  In {connection.app.name} ·{" "}
                  <span className="font-mono">
                    {scopesText(connection.scopes)}
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm">
                {connection.status === "expired" ? (
                  <Badge variant="warning">
                    Reconnect in {connection.app.name}
                  </Badge>
                ) : (
                  <Badge variant="success">Connected</Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDisconnecting(connection)}
                  aria-label={`Disconnect ${connection.providerName} from ${connection.app.name}`}
                >
                  <Unplug />
                  Disconnect
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.providerName} from ${disconnecting.app.name}?`}
          confirmLabel="Disconnect"
          destructive
          pending={disconnectMutation.isPending}
          onClose={() => setDisconnecting(null)}
          onConfirm={() =>
            disconnectMutation.mutate(
              { data: { connectionId: disconnecting.id } },
              { onSettled: () => setDisconnecting(null) },
            )
          }
        >
          {disconnecting.app.name} loses this account until you connect it again
          there.
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
