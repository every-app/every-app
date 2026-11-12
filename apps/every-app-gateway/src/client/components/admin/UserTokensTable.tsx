import { useMemo, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Unplug } from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
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
import { useTableSearch } from "@/client/components/table/useTableSearch";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { tokenAccessOf, type TokenAccess } from "@/server/user-pat-scopes";
import type { UserAccessToken } from "@/types/user-token";
import { TokenPrefix, TokenStatusBadge, tokenStatus } from "./tokenDisplay";

const ACCESS_LABELS: Record<TokenAccess, string> = {
  read: "Read only",
  full: "Full",
  deploy: "Deploy key",
};

function tokenSearchText(token: UserAccessToken) {
  return [token.name, token.tokenPrefix, token.appName, token.appSlug];
}

interface UserTokensTableProps {
  tokens: UserAccessToken[];
  isLoading: boolean;
  /** A load failure, shown above the rows. */
  error?: ReactNode;
  onRevoke: (token: UserAccessToken) => void;
  isRevoking: boolean;
}

export function UserTokensTable({
  tokens,
  isLoading,
  error,
  onRevoke,
  isRevoking,
}: UserTokensTableProps) {
  const columns = useMemo<ColumnDef<UserAccessToken>[]>(
    () => [
      {
        id: "name",
        accessorFn: (token) => token.name,
        header: ({ column }) => <SortableHeader column={column} label="Name" />,
        meta: { label: "Name", cellClassName: "max-w-[240px] truncate" },
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "access",
        header: "Access",
        meta: { card: CardSlot.BareDetail },
        cell: ({ row }) => {
          const access = tokenAccessOf(row.original.scopes);
          return access
            ? ACCESS_LABELS[access]
            : row.original.scopes.join(", ");
        },
      },
      {
        id: "prefix",
        header: "Prefix",
        meta: { card: CardSlot.Hidden },
        cell: ({ row }) => <TokenPrefix prefix={row.original.tokenPrefix} />,
      },
      {
        id: "appScope",
        header: "Apps",
        meta: { cellClassName: "max-w-[240px]", card: CardSlot.BareDetail },
        cell: ({ row }) =>
          row.original.appName ? (
            <>
              <p className="truncate">{row.original.appName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {row.original.appSlug}
              </p>
            </>
          ) : (
            <span className="text-muted-foreground">
              {row.original.scopes.includes("deploy")
                ? "Deploys any app"
                : "All my apps"}
            </span>
          ),
      },
      {
        id: "status",
        header: "Status",
        meta: { card: CardSlot.Trailing },
        cell: ({ row }) => (
          <TokenStatusBadge status={tokenStatus(row.original)} />
        ),
      },
      {
        id: "created",
        accessorFn: (token) => dateSortValue(token.createdAt, 0),
        header: ({ column }) => (
          <SortableHeader column={column} label="Created" />
        ),
        meta: {
          label: "Created",
          cellClassName: DATE_CELL,
          card: CardSlot.Hidden,
        },
        cell: ({ row }) => <DateCell value={row.original.createdAt} />,
      },
      {
        id: "expires",
        accessorFn: (token) =>
          dateSortValue(token.expiresAt, Number.POSITIVE_INFINITY),
        header: ({ column }) => (
          <SortableHeader column={column} label="Expires" />
        ),
        meta: { label: "Expires", cellClassName: DATE_CELL },
        cell: ({ row }) => <DateCell value={row.original.expiresAt} />,
      },
      {
        id: "lastUsed",
        accessorFn: (token) => dateSortValue(token.lastUsedAt, 0),
        header: ({ column }) => (
          <SortableHeader column={column} label="Last used" />
        ),
        meta: { label: "Last used", cellClassName: DATE_CELL },
        cell: ({ row }) => <DateCell value={row.original.lastUsedAt} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        meta: { headerClassName: "w-10" },
        // Only an active token has anything left to revoke.
        cell: ({ row }) =>
          tokenStatus(row.original) === "active" ? (
            <RowActionsMenu label={`Actions for ${row.original.name}`}>
              <DropdownMenuItem
                variant="destructive"
                disabled={isRevoking}
                onClick={() => onRevoke(row.original)}
              >
                <Unplug />
                Revoke token
              </DropdownMenuItem>
            </RowActionsMenu>
          ) : null,
      },
    ],
    [isRevoking, onRevoke],
  );

  const { rows, search } = useTableSearch(tokens, tokenSearchText, "tokens");
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (token) => token.id,
    withSorting: true,
  });

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      search={search}
      empty={{ title: "No tokens yet" }}
    />
  );
}
