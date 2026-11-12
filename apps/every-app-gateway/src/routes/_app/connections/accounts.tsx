import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { RotateCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConnectionApps } from "@/client/components/ConnectionApps";
import {
  useConnectionRemoval,
  type AppAccess,
} from "@/client/components/ConnectionRemoval";
import { ConnectionStatusBadge } from "@/client/components/ConnectionStatusBadge";
import { DeviceApps } from "@/client/components/DeviceApps";
import { ErrorState } from "@/client/components/ErrorState";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  SettingsSection,
  SettingsTab,
} from "@/client/components/SettingsLayout";
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
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/client/components/ui/dropdown-menu";
import { getRuleErrorMessage } from "@/client/errors";
import {
  CONNECTED_ACCOUNTS_KEY,
  useConnectedAccounts,
} from "@/client/hooks/useConnectedAccounts";
import {
  compareConnections,
  connectionName,
  scopesText,
} from "@/client/lib/oauthProviders";
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
 * app at once. People connect from inside an app.
 *
 * What a person comes here for is to see what their apps can reach, fix a
 * connection that stopped working, or take access away, so the ones that
 * need reconnecting come first with Reconnect on the row, an app's own MCP
 * server is named after the app, and a long scope list shows two and the
 * rest on request. Every row's menu has Reconnect too: on a healthy
 * connection it asks the provider again (`fresh`), and the new grant
 * replaces the person's one connection to it. Under them, the apps signed
 * in on their devices.
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
  onReconnect: (account: Account, options: { fresh: boolean }) => void;
  isReconnecting: boolean;
}): ColumnDef<Account>[] {
  return [
    {
      id: "account",
      accessorFn: (account) => {
        const name = connectionName(account);
        return `${name.title} ${name.subtitle ?? ""}`;
      },
      header: ({ column }) => (
        <SortableHeader column={column} label="Account" />
      ),
      meta: { label: "Account", cellClassName: "max-w-[320px]" },
      cell: ({ row: { original: account } }) => (
        <>
          <AccountName account={account} />
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
      meta: { cellClassName: "max-w-[320px] whitespace-normal" },
      cell: ({ row: { original: account } }) => (
        <Scopes scopes={account.scopes} />
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
            onClick={() => onReconnect(account, { fresh: false })}
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
        <RowActionsMenu label={`Actions for ${connectionName(account).title}`}>
          <DropdownMenuItem
            disabled={isReconnecting}
            onClick={() => onReconnect(account, { fresh: true })}
          >
            <RotateCw />
            Reconnect
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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

function AccountName({ account }: { account: Account }) {
  const name = connectionName(account);
  return (
    <>
      <p className="truncate font-medium">{name.title}</p>
      {name.subtitle ? (
        <p className="truncate text-xs text-muted-foreground">
          {name.subtitle}
        </p>
      ) : null}
    </>
  );
}

/** Scopes shown before "+N more". */
const SCOPES_SHOWN = 2;

/**
 * What the connection lets its apps do: the provider's own scope names,
 * the first two and the rest on request, so a long list (an MCP server's
 * seven lines) doesn't swamp the row.
 */
function Scopes({ scopes }: { scopes: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const hidden = scopes.length - SCOPES_SHOWN;
  if (open || hidden <= 0) {
    return <span className="font-mono text-xs">{scopesText(scopes)}</span>;
  }
  return (
    <span className="text-xs">
      <span className="font-mono">
        {scopesText(scopes.slice(0, SCOPES_SHOWN))}
      </span>{" "}
      <button
        type="button"
        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        aria-label={`Show all ${scopes.length} scopes`}
        onClick={() => setOpen(true)}
      >
        +{hidden} more
      </button>
    </span>
  );
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
        onReconnect: (account, { fresh }) =>
          reconnect({ data: { providerId: account.providerId, fresh } }),
        isReconnecting,
      }),
    [reconnect, isReconnecting],
  );
  const accounts = useMemo(
    () => [...(accountsQuery.data?.connections ?? [])].sort(compareConnections),
    [accountsQuery.data],
  );
  const table = useDataTable({
    data: accounts,
    columns,
    getRowId: (account) => account.id,
    withSorting: true,
  });

  return (
    <>
      <SettingsTab>
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

        <DeviceApps />
      </SettingsTab>

      {removal.dialogs}
    </>
  );
}
