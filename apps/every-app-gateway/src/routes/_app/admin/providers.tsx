import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, Link2, Plus, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { AddOAuthProviderDialog } from "@/client/components/admin/AddOAuthProviderDialog";
import { ReplaceOAuthClientDialog } from "@/client/components/admin/ReplaceOAuthClientDialog";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { getRuleErrorMessage } from "@/client/errors";
import {
  clientSourceLabel,
  connectPathFor,
  scopeSetsText,
} from "@/client/lib/oauthProviders";
import {
  disconnectConnection,
  listAllConnections,
} from "@/serverFunctions/connections";
import {
  addOAuthProvider,
  listProviders,
  removeOAuthClient,
  removeProvider,
  setOAuthClient,
} from "@/serverFunctions/providers";

export const Route = createFileRoute("/_app/admin/providers")({
  component: ProvidersPage,
});

const PROVIDERS_KEY = ["admin", "providers"] as const;
const CONNECTIONS_KEY = ["admin", "providerConnections"] as const;

type Provider = Awaited<ReturnType<typeof listProviders>>["providers"][number];
type OAuthProvider = NonNullable<Provider["oauth"]>;
type Connection = Awaited<
  ReturnType<typeof listAllConnections>
>["connections"][number];

const KIND_LABEL: Record<Provider["kind"], string> = {
  api_key: "API key",
  oauth: "OAuth",
  ai: "AI",
  service: "Gateway service",
};

/** The same path the callback returns to after "Connect for the organization". */
const ADMIN_RETURN_PATH = "/admin/providers";

function providerColumns({
  onReplaceClient,
  onForgetClient,
  onRemove,
}: {
  onReplaceClient: (provider: OAuthProvider) => void;
  onForgetClient: (provider: OAuthProvider) => void;
  onRemove: (provider: Provider) => void;
}): ColumnDef<Provider>[] {
  return [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: { label: "Provider", cellClassName: "max-w-[260px]" },
      cell: ({ row: { original: provider } }) => (
        <>
          <p className="truncate font-medium">{provider.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider.id}
          </p>
        </>
      ),
    },
    {
      accessorKey: "kind",
      header: ({ column }) => <SortableHeader column={column} label="Kind" />,
      meta: { label: "Kind" },
      cell: ({ row: { original: provider } }) => (
        <Badge variant="secondary">{KIND_LABEL[provider.kind]}</Badge>
      ),
    },
    {
      accessorKey: "source",
      header: ({ column }) => <SortableHeader column={column} label="Source" />,
      meta: { label: "Source", cellClassName: "text-xs text-muted-foreground" },
      cell: ({ row: { original: provider } }) =>
        provider.source === "catalog" ? "Built in" : "Registered here",
    },
    {
      id: "client",
      header: "OAuth client",
      enableSorting: false,
      cell: ({ row: { original: provider } }) => {
        const entry = provider.oauth;
        if (!entry) {
          return (
            <span className="text-xs text-muted-foreground">
              {provider.kind === "service" ? "—" : provider.hosts.join(", ")}
            </span>
          );
        }
        const view = clientSourceLabel(entry.client);
        return (
          <span
            className={view.tone === "unset" ? "text-muted-foreground" : ""}
          >
            {view.label}
            {entry.client.stale ? (
              <Badge variant="warning" size="sm" className="ml-2">
                Pasted for other endpoints
              </Badge>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "connections",
      accessorFn: (provider) => provider.oauth?.connections ?? -1,
      header: ({ column }) => (
        <SortableHeader column={column} label="Connections" />
      ),
      meta: { label: "Connections" },
      cell: ({ row: { original: provider } }) =>
        provider.oauth ? provider.oauth.connections : "—",
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: provider } }) => {
        const entry = provider.oauth;
        if (!entry && provider.source === "catalog") return null;
        return (
          <RowActionsMenu label={`Actions for ${provider.name}`}>
            {entry ? (
              <DropdownMenuItem onClick={() => onReplaceClient(entry)}>
                <KeyRound />
                {entry.client.source ? "Replace client" : "Set client"}
              </DropdownMenuItem>
            ) : null}
            {entry?.client.source === "d1" ? (
              <DropdownMenuItem onClick={() => onForgetClient(entry)}>
                <Unplug />
                Forget pasted client
              </DropdownMenuItem>
            ) : null}
            {entry?.client.source ? (
              <DropdownMenuItem
                render={
                  <a
                    href={connectPathFor(entry.id, {
                      account: "organization",
                      returnTo: ADMIN_RETURN_PATH,
                    })}
                  />
                }
              >
                <Link2 />
                Connect for the organization
              </DropdownMenuItem>
            ) : null}
            {provider.source === "row" ? (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onRemove(provider)}
              >
                <Trash2 />
                Remove provider
              </DropdownMenuItem>
            ) : null}
          </RowActionsMenu>
        );
      },
    },
  ];
}

function connectionColumns({
  onDisconnect,
  isDisconnecting,
}: {
  onDisconnect: (connection: Connection) => void;
  isDisconnecting: boolean;
}): ColumnDef<Connection>[] {
  return [
    {
      id: "who",
      accessorFn: (connection) =>
        connection.account === "organization"
          ? "Organization"
          : (connection.userEmail ?? connection.userId ?? ""),
      header: ({ column }) => <SortableHeader column={column} label="Who" />,
      meta: { label: "Who", cellClassName: "max-w-[240px]" },
      cell: ({ row: { original: connection } }) => (
        <>
          <p className="truncate font-medium">
            {connection.account === "organization"
              ? "The organization"
              : (connection.userEmail ?? connection.userId)}
          </p>
          {connection.label ? (
            <p className="truncate text-xs text-muted-foreground">
              {connection.label}
            </p>
          ) : null}
        </>
      ),
    },
    {
      accessorKey: "providerName",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: { label: "Provider" },
    },
    {
      id: "scopeSets",
      header: "Scope sets",
      enableSorting: false,
      meta: { cellClassName: "font-mono text-xs text-muted-foreground" },
      cell: ({ row: { original: connection } }) =>
        scopeSetsText(connection.scopeSets),
    },
    {
      accessorKey: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row: { original: connection } }) =>
        connection.status === "expired" ? (
          <Badge variant="warning">Needs reconnecting</Badge>
        ) : (
          <Badge variant="success">Connected</Badge>
        ),
    },
    {
      id: "lastUsedAt",
      accessorFn: (connection) => dateSortValue(connection.lastUsedAt, 0),
      header: ({ column }) => (
        <SortableHeader column={column} label="Last used" />
      ),
      meta: {
        label: "Last used",
        cellClassName: "text-xs text-muted-foreground",
      },
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
        <RowActionsMenu
          label={`Actions for ${connection.providerName} connection`}
        >
          <DropdownMenuItem
            variant="destructive"
            disabled={isDisconnecting}
            onClick={() => onDisconnect(connection)}
          >
            <Unplug />
            Disconnect
          </DropdownMenuItem>
        </RowActionsMenu>
      ),
    },
  ];
}

/**
 * Manage workspace → Providers (docs/design/2026-10-oauth-providers.md
 * section 9): every provider the Gateway brokers, where each one's key or
 * client comes from (never a value), the OAuth ones with their redirect
 * URI and connection count; Add OAuth provider from a preset or a custom
 * spec with the client pasted in; Replace or Forget a client; Remove a
 * registered provider; and every connection in the organization, each
 * disconnectable. Owners and admins.
 */
function ProvidersPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<OAuthProvider | null>(null);
  const [forgetting, setForgetting] = useState<OAuthProvider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);

  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => listProviders(),
  });
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => listAllConnections(),
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY }),
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
    ]);
  };

  const addMutation = useMutation({
    mutationFn: addOAuthProvider,
    onSuccess: async (provider) => {
      await refresh();
      setAdding(false);
      toast.success(`${provider.name} added`);
    },
  });
  const replaceMutation = useMutation({
    mutationFn: setOAuthClient,
    onSuccess: async (provider) => {
      await refresh();
      setReplacing(null);
      toast.success(`${provider.name} client saved`);
    },
  });
  const forgetMutation = useMutation({
    mutationFn: removeOAuthClient,
    onSuccess: async () => {
      await refresh();
      toast.success("Pasted client forgotten");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to forget the client")),
  });
  const removeMutation = useMutation({
    mutationFn: removeProvider,
    onSuccess: async () => {
      await refresh();
      toast.success("Provider removed");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to remove the provider")),
  });
  const disconnectMutation = useMutation({
    mutationFn: disconnectConnection,
    onSuccess: async () => {
      await refresh();
      toast.success("Disconnected");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to disconnect")),
  });

  const providerCols = useMemo(
    () =>
      providerColumns({
        onReplaceClient: setReplacing,
        onForgetClient: setForgetting,
        onRemove: setRemoving,
      }),
    [],
  );
  const providersTable = useDataTable({
    data: providersQuery.data?.providers ?? [],
    columns: providerCols,
    getRowId: (provider) => provider.id,
    withSorting: true,
  });
  const connectionCols = useMemo(
    () =>
      connectionColumns({
        onDisconnect: setDisconnecting,
        isDisconnecting: disconnectMutation.isPending,
      }),
    [disconnectMutation.isPending],
  );
  const connectionsTable = useDataTable({
    data: connectionsQuery.data?.connections ?? [],
    columns: connectionCols,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });

  // A custom provider's redirect URI, before it exists: the same path every
  // provider's is, on the Gateway the presets were listed from.
  const redirectUriFor = (id: string): string => {
    const sample = providersQuery.data?.providers.find(
      (provider) => provider.oauth,
    )?.oauth?.redirectUri;
    const origin = sample
      ? sample.slice(0, sample.indexOf("/connect/"))
      : typeof window === "undefined"
        ? ""
        : window.location.origin;
    return `${origin}/connect/${id}/callback`;
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SectionHeader
          title="Providers"
          hint="The APIs apps reach through the Gateway: keys and OAuth clients it holds, never shown back. An OAuth provider lets each person connect their own account."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add OAuth provider
            </Button>
          }
        />
        <DataTable
          table={providersTable}
          isLoading={providersQuery.isLoading}
          error={
            providersQuery.isError ? (
              <ErrorState
                message="Couldn't load the providers."
                onRetry={() => void providersQuery.refetch()}
                isRetrying={providersQuery.isFetching}
              />
            ) : undefined
          }
          empty={{
            title: "No providers",
            description:
              "Add an OAuth provider to let people connect an account.",
          }}
        />
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Connections"
          hint="Every account connected in this workspace: each person's and the organization's. Disconnecting removes the tokens here and, where the provider allows, revokes them."
        />
        <DataTable
          table={connectionsTable}
          isLoading={connectionsQuery.isLoading}
          error={
            connectionsQuery.isError ? (
              <ErrorState
                message="Couldn't load the connections."
                onRetry={() => void connectionsQuery.refetch()}
                isRetrying={connectionsQuery.isFetching}
              />
            ) : undefined
          }
          empty={{
            title: "No connections yet",
            description:
              "People connect under their account's Connected accounts; the organization's from a provider's menu above.",
          }}
        />
      </section>

      {adding ? (
        <AddOAuthProviderDialog
          redirectUriFor={redirectUriFor}
          onSubmit={async (input) => {
            await addMutation.mutateAsync({ data: input });
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {replacing ? (
        <ReplaceOAuthClientDialog
          provider={{
            id: replacing.id,
            name: replacing.name,
            redirectUri: replacing.redirectUri,
            console: replacing.console,
            clientSource: replacing.client.source,
          }}
          onSubmit={async (client) => {
            await replaceMutation.mutateAsync({
              data: { providerId: replacing.id, ...client },
            });
          }}
          onClose={() => setReplacing(null)}
        />
      ) : null}

      {forgetting ? (
        <ConfirmDialog
          title={`Forget the pasted ${forgetting.name} client?`}
          confirmLabel="Forget client"
          destructive
          pending={forgetMutation.isPending}
          onClose={() => setForgetting(null)}
          onConfirm={() =>
            forgetMutation.mutate(
              { data: { providerId: forgetting.id } },
              { onSettled: () => setForgetting(null) },
            )
          }
        >
          New connections stop until a client is set again; existing tokens keep
          working until they expire.
        </ConfirmDialog>
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove provider"
          destructive
          pending={removeMutation.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            removeMutation.mutate(
              { data: { providerId: removing.id } },
              { onSettled: () => setRemoving(null) },
            )
          }
        >
          Its client and every connection go with it. Refused while an app lists
          it.
        </ConfirmDialog>
      ) : null}

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
                  account: disconnecting.account,
                  ...(disconnecting.account === "user" && disconnecting.userId
                    ? { userId: disconnecting.userId }
                    : {}),
                },
              },
              { onSettled: () => setDisconnecting(null) },
            )
          }
        >
          {disconnecting.account === "organization"
            ? "Background work that uses the organization's account stops until someone connects it again."
            : "Apps lose this person's account until they connect again."}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
