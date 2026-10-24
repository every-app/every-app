import { useMemo, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Unplug } from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import type { UserAccessToken } from "@/types/user-token";
import { TokenPrefix, TokenStatusBadge, tokenStatus } from "./tokenDisplay";

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
        meta: { cellClassName: "max-w-[240px] truncate font-medium" },
        cell: ({ row }) =>
          row.original.scopes.includes("deploy")
            ? `${row.original.name} (deploy key)`
            : row.original.name,
      },
      {
        id: "prefix",
        header: "Prefix",
        cell: ({ row }) => <TokenPrefix prefix={row.original.tokenPrefix} />,
      },
      {
        id: "appScope",
        header: "App scope",
        meta: { cellClassName: "max-w-[240px]" },
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
        meta: { cellClassName: "text-xs text-muted-foreground" },
        cell: ({ row }) => <DateCell value={row.original.createdAt} />,
      },
      {
        id: "expires",
        accessorFn: (token) =>
          dateSortValue(token.expiresAt, Number.POSITIVE_INFINITY),
        header: ({ column }) => (
          <SortableHeader column={column} label="Expires" />
        ),
        meta: { cellClassName: "text-xs text-muted-foreground" },
        cell: ({ row }) => <DateCell value={row.original.expiresAt} />,
      },
      {
        id: "lastUsed",
        accessorFn: (token) => dateSortValue(token.lastUsedAt, 0),
        header: ({ column }) => (
          <SortableHeader column={column} label="Last used" />
        ),
        meta: { cellClassName: "text-xs text-muted-foreground" },
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

  const table = useDataTable({
    data: tokens,
    columns,
    getRowId: (token) => token.id,
    withSorting: true,
  });

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      empty={{ title: "No tokens yet" }}
    />
  );
}
