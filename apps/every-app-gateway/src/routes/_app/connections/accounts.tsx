import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConnectionApps } from "@/client/components/ConnectionApps";
import {
  useConnectionRemoval,
  type AppAccess,
} from "@/client/components/ConnectionRemoval";
import { ConnectionStatusBadge } from "@/client/components/ConnectionStatusBadge";
import { ErrorState } from "@/client/components/ErrorState";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { SettingsSection } from "@/client/components/SettingsLayout";
import {
  CardSlot,
  DataTable,
  useDataTable,
} from "@/client/components/table/DataTable";
import {
  DATE_CELL,
  DateCell,
  dateSortValue,
} from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Button } from "@/client/components/ui/button";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { getRuleErrorMessage } from "@/client/errors";
import {
  CONNECTED_ACCOUNTS_KEY,
  useConnectedAccounts,
} from "@/client/hooks/useConnectedAccounts";
import { scopesText } from "@/client/lib/oauthProviders";
import { ReconnectOutcome } from "@/schemas/app-access";
import {
  reconnectConnection,
  type listMyConnections,
} from "@/serverFunctions/connections";

/**
 * Your connections → Accounts
 * (docs/design/2026-11-oauth-one-connection.md): the OAuth accounts this person connected through the Gateway, one row per
 * provider, with the scopes the connection holds and the apps they allowed
 * to use it. One app's access can be taken away, and Disconnect stops every
 * app at once. People connect from inside an app. Reconnect shows where an
 * app they allowed needs more than the connection or their OK gives it,
 * and gets it for every one of those apps at once.
 */
export const Route = createFileRoute("/_app/connections/accounts")({
  component: AccountsTab,
});

type Account = Awaited<
  ReturnType<typeof listMyConnections>
>["connections"][number];

function accountColumns({
  onDisconnect,
  onRemoveApp,
  onReconnect,
  isReconnecting,
}: {
  onDisconnect: (account: Account) => void;
  onRemoveApp: (access: AppAccess<Account>) => void;
  onReconnect: (account: Account) => void;
  isReconnecting: boolean;
}): ColumnDef<Account>[] {
  return [
    {
      id: "account",
      accessorFn: (account) => `${account.providerName} ${account.label ?? ""}`,
      header: ({ column }) => (
        <SortableHeader column={column} label="Account" />
      ),
      meta: { label: "Account", cellClassName: "max-w-[320px]" },
      cell: ({ row: { original: account } }) => (
        <>
          <p className="truncate font-medium">{account.providerName}</p>
          {account.label ? (
            <p className="truncate text-xs text-muted-foreground">
              {account.label}
            </p>
          ) : null}
          {account.apps.length > 0 ? (
            // The label keeps its place when the apps wrap onto more lines.
            <div className="mt-1 flex items-baseline gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0">Used by</span>
              <ConnectionApps
                apps={account.apps}
                onRemove={(app) => onRemoveApp({ connection: account, app })}
              />
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              No app can use it yet.
            </p>
          )}
        </>
      ),
    },
    {
      id: "access",
      header: "Access",
      enableSorting: false,
      // Every scope shows: a long list wraps, it is never cut short.
      meta: { cellClassName: "max-w-[320px] whitespace-normal" },
      cell: ({ row: { original: account } }) => (
        <span className="font-mono text-xs">{scopesText(account.scopes)}</span>
      ),
    },
    {
      accessorKey: "status",
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      meta: { label: "Status", card: CardSlot.BareDetail },
      cell: ({ row: { original: account } }) => (
        <ConnectionStatusBadge connection={account} />
      ),
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => (
        <SortableHeader column={column} label="Connected" />
      ),
      meta: { label: "Connected", cellClassName: DATE_CELL },
      cell: ({ row: { original: account } }) => (
        <DateCell value={account.createdAt} />
      ),
    },
    {
      id: "lastUsedAt",
      // Never used sorts as the oldest.
      accessorFn: (account) => dateSortValue(account.lastUsedAt, 0),
      header: ({ column }) => (
        <SortableHeader column={column} label="Last used" />
      ),
      meta: { label: "Last used", cellClassName: DATE_CELL },
      cell: ({ row: { original: account } }) => (
        <DateCell value={account.lastUsedAt} />
      ),
    },
    {
      // Its own column at the row's end, beside the menu, so the button
      // lines up down the table.
      id: "reconnect",
      header: () => <span className="sr-only">Reconnect</span>,
      enableSorting: false,
      meta: {
        headerClassName: "w-px",
        cellClassName: "text-right",
        card: CardSlot.Trailing,
      },
      cell: ({ row: { original: account } }) =>
        account.needsReconnect ? (
          <Button
            size="sm"
            disabled={isReconnecting}
            onClick={() => onReconnect(account)}
          >
            Reconnect
          </Button>
        ) : null,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: account } }) => (
        <RowActionsMenu label={`Actions for ${account.providerName}`}>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDisconnect(account)}
          >
            <Unplug />
            Disconnect
          </DropdownMenuItem>
        </RowActionsMenu>
      ),
    },
  ];
}

function AccountsTab() {
  const queryClient = useQueryClient();
  const accountsQuery = useConnectedAccounts();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: CONNECTED_ACCOUNTS_KEY });
  const removal = useConnectionRemoval<Account>({
    person: null,
    onChanged: refresh,
  });
  const reconnectMutation = useMutation({
    mutationFn: reconnectConnection,
    onSuccess: async (result) => {
      if (result.outcome === ReconnectOutcome.Provider) {
        window.location.assign(result.url);
        return;
      }
      await refresh();
      toast.success(`${result.provider} reconnected`);
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to reconnect")),
  });
  const { mutate: reconnect, isPending: isReconnecting } = reconnectMutation;

  const columns = useMemo(
    () =>
      accountColumns({
        onDisconnect: removal.askDisconnect,
        onRemoveApp: removal.askRemoveApp,
        onReconnect: (account) =>
          reconnect({ data: { providerId: account.providerId } }),
        isReconnecting,
      }),
    [reconnect, isReconnecting],
  );
  const table = useDataTable({
    data: accountsQuery.data?.connections ?? [],
    columns,
    getRowId: (account) => account.id,
    withSorting: true,
  });

  return (
    <>
      <SettingsSection
        title="Connected accounts"
        hint="Accounts you've connected, such as Gmail, and the apps you allow to use them."
      >
        <DataTable
          table={table}
          isLoading={accountsQuery.isLoading}
          error={
            accountsQuery.isError ? (
              <ErrorState
                message="Couldn't load your connected accounts."
                onRetry={() => void accountsQuery.refetch()}
                isRetrying={accountsQuery.isFetching}
              />
            ) : undefined
          }
          empty={{
            title: "No connected accounts yet",
            description: "Connect one from inside an app.",
          }}
        />
      </SettingsSection>

      {removal.dialogs}
    </>
  );
}
