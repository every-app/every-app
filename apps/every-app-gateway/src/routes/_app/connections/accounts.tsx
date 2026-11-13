import { useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { PanelRight, RotateCw, Unplug, UserMinus } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { ConnectedAccountSheet } from "@/client/components/ConnectedAccountSheet";
import {
  useConnectionRemoval,
  type AppAccess,
} from "@/client/components/ConnectionRemoval";
import { DeviceApps } from "@/client/components/DeviceApps";
import { ErrorState } from "@/client/components/ErrorState";
import { ProviderTile } from "@/client/components/ProviderIcon";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  SettingsSection,
  SettingsTab,
} from "@/client/components/SettingsLayout";
import {
  CardSlot,
  DataTable,
  useDataTable,
  useInDataTableCard,
} from "@/client/components/table/DataTable";
import {
  DATE_CELL,
  DateCell,
  dateSortValue,
} from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { useTableSearch } from "@/client/components/table/useTableSearch";
import { Badge } from "@/client/components/ui/badge";
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
  accessWords,
  appsToName,
  compareConnections,
  connectionName,
  namesText,
} from "@/client/lib/oauthProviders";
import { ReconnectOutcome } from "@/schemas/app-access";
import {
  reconnectConnection,
  type listMyConnections,
} from "@/serverFunctions/connections";

/**
 * Your connections → Accounts
 * (docs/design/2026-11-oauth-one-connection.md): the OAuth accounts this
 * person connected through the Gateway, one row per provider. People
 * connect from inside an app.
 *
 * What a person comes here for is to see what their apps can reach, fix a
 * connection that stopped working, or take access away, so a row is one
 * line of what answers that: the account by the name people know it by,
 * what it lets apps do in a few words, and when it was last used. The
 * apps allowed to use it are named only when that says something (not
 * "Context, used by Context"), and a row says how it stands only when it
 * needs something: the ones to reconnect (expired, or an app lists a
 * permission the provider was never asked for) come first, with Reconnect
 * on the row. A connection that holds part of what its apps list works,
 * and says so in its Access ("Read only · 10 of 18 granted"), no badge. The rest is behind the row (`ConnectedAccountSheet`): every
 * permission in the provider's own names, when it was connected, and each
 * app with the button that takes its access away. The row's menu has
 * those too, with Reconnect (on a healthy connection it asks the provider
 * again, `fresh`, and the new grant replaces the person's one connection
 * to it) and Disconnect, which stops every app at once. Under the
 * accounts, the apps signed in on their devices.
 */
export const Route = createFileRoute("/_app/connections/accounts")({
  component: AccountsTab,
});

type Account = Awaited<
  ReturnType<typeof listMyConnections>
>["connections"][number];

function accountSearchText(account: Account) {
  const name = connectionName(account);
  return [
    name.title,
    name.subtitle,
    account.providerName,
    ...account.apps.map((app) => app.name),
  ];
}

/** Keeps a click on a row's own controls from also opening the row. */
function RowControls({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-end gap-2"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

function accountColumns({
  onDetails,
  onDisconnect,
  onRemoveApp,
  onReconnect,
  isReconnecting,
}: {
  onDetails: (account: Account) => void;
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
      meta: { label: "Account", cellClassName: "max-w-[420px]" },
      cell: ({ row: { original: account } }) => (
        <AccountName account={account} />
      ),
    },
    {
      id: "access",
      header: "Access",
      enableSorting: false,
      meta: { cellClassName: "max-w-[260px] truncate" },
      cell: ({ row: { original: account } }) => {
        if (account.scopes.length === 0) {
          return <span className="text-muted-foreground">None</span>;
        }
        // Granting part of what the apps list is the person's choice: said
        // quietly beside the access, with the list behind the row.
        const { words, partial } = accessWords(account);
        return partial ? (
          <>
            {words}
            <span className="text-muted-foreground"> · {partial}</span>
          </>
        ) : (
          words
        );
      },
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
          <RowControls>
            <Button
              size="sm"
              disabled={isReconnecting}
              onClick={() => onReconnect(account, { fresh: false })}
            >
              Reconnect
            </Button>
          </RowControls>
        ) : null,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: account } }) => (
        <RowControls>
          <RowActionsMenu
            label={`Actions for ${connectionName(account).title}`}
          >
            <DropdownMenuItem onClick={() => onDetails(account)}>
              <PanelRight />
              View details
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isReconnecting}
              onClick={() => onReconnect(account, { fresh: true })}
            >
              <RotateCw />
              Reconnect
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {appsToName(account).map((app) => (
              <DropdownMenuItem
                key={app.rowId}
                onClick={() => onRemoveApp({ connection: account, app })}
              >
                <UserMinus />
                Remove {app.name}'s access
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDisconnect(account)}
            >
              <Unplug />
              Disconnect
            </DropdownMenuItem>
          </RowActionsMenu>
        </RowControls>
      ),
    },
  ];
}

/**
 * The account's mark and name, with how it stands when it needs
 * something, and one quiet line under it for what isn't obvious: which
 * account it is at the provider, and the apps that use it.
 */
function AccountName({ account }: { account: Account }) {
  // A card has the row's width to itself: the line wraps, and Reconnect
  // beside the name already says how the account stands.
  const inCard = useInDataTableCard();
  const name = connectionName(account);
  const apps = appsToName(account);
  const usedBy =
    account.apps.length === 0
      ? "No app uses it yet"
      : apps.length > 0
        ? `Used by ${namesText(apps.map((app) => app.name))}`
        : null;
  const detail = [name.subtitle, usedBy].filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-0 items-center gap-3">
      <ProviderTile id={name.mark} name={name.title} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{name.title}</span>
          {account.needsReconnect ? (
            inCard ? null : (
              <Badge variant="warning">Needs reconnect</Badge>
            )
          ) : account.status === "expired" ? (
            <Badge variant="secondary">Expired</Badge>
          ) : null}
        </p>
        {detail ? (
          <p
            className={cn(
              "text-xs text-muted-foreground",
              inCard ? "wrap-anywhere" : "truncate",
            )}
          >
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AccountsTab() {
  const queryClient = useQueryClient();
  const accountsQuery = useConnectedAccounts();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: CONNECTED_ACCOUNTS_KEY });
  const removal = useConnectionRemoval<Account>({
    person: null,
    name: (account) => connectionName(account).title,
    onChanged: refresh,
  });
  // The account whose details are open, by id: the sheet follows a refresh,
  // and closes when its account is disconnected.
  const [detailsId, setDetailsId] = useState<string | null>(null);
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

  const onReconnect = (account: Account, { fresh }: { fresh: boolean }) =>
    reconnect({ data: { providerId: account.providerId, fresh } });
  const columns = useMemo(
    () =>
      accountColumns({
        onDetails: (account) => setDetailsId(account.id),
        onDisconnect: removal.askDisconnect,
        onRemoveApp: removal.askRemoveApp,
        onReconnect: (account, { fresh }) =>
          reconnect({ data: { providerId: account.providerId, fresh } }),
        isReconnecting,
      }),
    // `removal`'s askers are state setters, the same on every render.
    [reconnect, isReconnecting],
  );
  const accounts = useMemo(
    () => [...(accountsQuery.data?.connections ?? [])].sort(compareConnections),
    [accountsQuery.data],
  );
  const details = accounts.find((account) => account.id === detailsId);
  const search = useTableSearch(accounts, accountSearchText, "accounts");
  const table = useDataTable({
    data: search.rows,
    columns,
    getRowId: (account) => account.id,
    withSorting: true,
  });

  return (
    <>
      <SettingsTab>
        <SettingsSection title="Connected accounts">
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
            search={search.search}
            onRowClick={(row) => setDetailsId(row.original.id)}
            activeRowId={details?.id}
            empty={{
              title: "No connected accounts yet",
              description: "Connect one from inside an app.",
            }}
          />
        </SettingsSection>

        <DeviceApps />
      </SettingsTab>

      {details ? (
        <ConnectedAccountSheet
          account={details}
          isReconnecting={isReconnecting}
          onReconnect={onReconnect}
          onRemoveApp={removal.askRemoveApp}
          onDisconnect={removal.askDisconnect}
          onClose={() => setDetailsId(null)}
        />
      ) : null}

      {removal.dialogs}
    </>
  );
}
