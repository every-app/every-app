import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Unplug } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { Page, PageHeader } from "@/client/components/PageHeader";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getRuleErrorMessage } from "@/client/errors";
import {
  ACCOUNTS_RETURN_PATH,
  callbackNotice,
  connectPathFor,
  scopeSetsText,
} from "@/client/lib/oauthProviders";
import {
  disconnectConnection,
  listConnectableProviders,
  listMyConnections,
} from "@/serverFunctions/connections";

const searchSchema = z.object({
  /** The provider just connected, set by the callback's return. */
  connected: z.string().optional(),
  /** The callback's refusal code. */
  error: z.string().optional(),
});

/**
 * Settings → Connected accounts (docs/design/2026-10-oauth-providers.md
 * section 5): the OAuth accounts this person connected through the
 * Gateway, a Connect button for every OAuth provider with a live client,
 * Reconnect for one that expired, Disconnect. The callback returns here
 * with `?connected=<id>` or `?error=<code>`.
 */
export const Route = createFileRoute("/_app/settings/accounts")({
  validateSearch: searchSchema,
  component: AccountsPage,
});

const MY_CONNECTIONS_KEY = ["settings", "providerConnections"] as const;
const CONNECTABLE_KEY = ["settings", "connectableProviders"] as const;

type Connection = Awaited<
  ReturnType<typeof listMyConnections>
>["connections"][number];

function AccountsPage() {
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const notice = useMemo(() => callbackNotice(search), [search]);

  const connectionsQuery = useQuery({
    queryKey: MY_CONNECTIONS_KEY,
    queryFn: () => listMyConnections(),
  });
  const providersQuery = useQuery({
    queryKey: CONNECTABLE_KEY,
    queryFn: () => listConnectableProviders(),
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
  const byProvider = new Map(
    connections.map((connection) => [connection.providerId, connection]),
  );
  const providers = providersQuery.data?.providers ?? [];
  const loading = connectionsQuery.isLoading || providersQuery.isLoading;
  const failed = connectionsQuery.isError || providersQuery.isError;

  return (
    <Page>
      <PageHeader title="Connected accounts" />
      <p className="text-sm text-muted-foreground">
        Accounts apps may use on your behalf, through the Gateway. An app never
        sees the token; disconnecting stops it at once.
      </p>

      {notice ? (
        <Alert variant={notice.kind === "error" ? "destructive" : "default"}>
          {notice.kind === "error" ? <CircleAlert /> : <CircleCheck />}
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}

      {failed ? (
        <ErrorState
          message="Couldn't load your connected accounts."
          onRetry={() => {
            void connectionsQuery.refetch();
            void providersQuery.refetch();
          }}
          isRetrying={connectionsQuery.isFetching || providersQuery.isFetching}
        />
      ) : loading ? (
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : providers.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No provider to connect yet. An owner or admin adds one under Manage
          workspace → Providers.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border"
          aria-label="Connected accounts"
        >
          {providers.map((provider) => {
            const connection = byProvider.get(provider.id);
            const expired = connection?.status === "expired";
            const connectHref = connectPathFor(provider.id, {
              account: "user",
              returnTo: ACCOUNTS_RETURN_PATH,
            });
            return (
              <li
                key={provider.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">{provider.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {connection
                      ? `${connection.label ?? "Connected"} · ${scopeSetsText(connection.scopeSets)}`
                      : "Not connected"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm">
                  {connection ? (
                    expired ? (
                      <Badge variant="warning">Needs reconnecting</Badge>
                    ) : (
                      <Badge variant="success">Connected</Badge>
                    )
                  ) : null}
                  {!connection || expired ? (
                    <Button
                      size="sm"
                      variant={expired ? "outline" : "default"}
                      nativeButton={false}
                      render={<a href={connectHref} />}
                    >
                      {expired ? "Reconnect" : `Connect ${provider.name}`}
                    </Button>
                  ) : null}
                  {connection ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDisconnecting(connection)}
                      aria-label={`Disconnect ${provider.name}`}
                    >
                      <Unplug />
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.providerName}?`}
          confirmLabel="Disconnect"
          destructive
          pending={disconnectMutation.isPending}
          onClose={() => setDisconnecting(null)}
          onConfirm={() =>
            disconnectMutation.mutate(
              {
                data: {
                  providerId: disconnecting.providerId,
                  account: "user",
                },
              },
              { onSettled: () => setDisconnecting(null) },
            )
          }
        >
          Apps lose this account until you connect it again.
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
