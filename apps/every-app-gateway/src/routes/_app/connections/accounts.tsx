import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
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
import { Badge } from "@/client/components/ui/badge";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { getRuleErrorMessage } from "@/client/errors";
import {
  CONNECTED_ACCOUNTS_KEY,
  useConnectedAccounts,
} from "@/client/hooks/useConnectedAccounts";
import { scopesText } from "@/client/lib/oauthProviders";
import {
  disconnectConnection,
  type listMyConnections,
} from "@/serverFunctions/connections";

/**
 * Connections → Accounts (docs/design/2026-11-oauth-simplify.md): the OAuth
 * accounts this person connected through the Gateway, one row per
 * connection, each one app's, with the scopes it holds and Disconnect.
 * People connect inside each app, so nothing here starts a connect.
 */
export const Route = createFileRoute("/_app/connections/accounts")({
  component: AccountsTab,
});

type Account = Awaited<
  ReturnType<typeof listMyConnections>
>["connections"][number];

function accountColumns(
  onDisconnect: (account: Account) => void,
): ColumnDef<Account>[] {
  return [
    {
      id: "account",
      accessorFn: (account) => `${account.providerName} ${account.label ?? ""}`,
      header: ({ column }) => (
        <SortableHeader column={column} label="Account" />
      ),
      meta: { label: "Account", cellClassName: "max-w-[280px]" },
      cell: ({ row: { original: account } }) => (
        <>
          <p className="truncate font-medium">{account.providerName}</p>
          {account.label ? (
            <p className="truncate text-xs text-muted-foreground">
              {account.label}
            </p>
          ) : null}
        </>
      ),
    },
    {
      id: "app",
      accessorFn: (account) => account.app.name,
      header: ({ column }) => <SortableHeader column={column} label="App" />,
      meta: { label: "App", cellClassName: "max-w-[240px] truncate" },
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
      id: "status",
      accessorFn: (account) => account.status,
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      meta: { label: "Status", card: CardSlot.BareDetail },
      cell: ({ row: { original: account } }) =>
        account.status === "expired" ? (
          <Badge variant="warning">Reconnect in {account.app.name}</Badge>
        ) : (
          <Badge variant="success">Connected</Badge>
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
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: account } }) => (
        <RowActionsMenu
          label={`Actions for ${account.providerName} in ${account.app.name}`}
        >
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
  const [disconnecting, setDisconnecting] = useState<Account | null>(null);

  const accountsQuery = useConnectedAccounts();
  const disconnectMutation = useMutation({
    mutationFn: disconnectConnection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONNECTED_ACCOUNTS_KEY });
      toast.success("Disconnected");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to disconnect")),
  });

  const columns = useMemo(() => accountColumns(setDisconnecting), []);
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
        hint="Accounts you've connected inside your apps, such as Gmail."
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
            description: "Connect one inside an app.",
          }}
        />
      </SettingsSection>

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
    </>
  );
}
