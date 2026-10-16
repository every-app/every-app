import { useMemo, useState, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import {
  DataTableSearch,
  DataTableToolbar,
} from "@/client/components/table/DataTableToolbar";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import type { AdminAppToken } from "@/types/app-token";
import { TokenPrefix, TokenStatusBadge, tokenStatus } from "./tokenDisplay";

interface AppTokensTableProps {
  tokens: AdminAppToken[];
  isLoading: boolean;
  /** A load failure, shown above the rows. */
  error?: ReactNode;
  onRevoke: (token: AdminAppToken) => void;
  isRevoking: boolean;
  isOwner: boolean;
}

// The search box appears once the list is long enough to need it.
const SEARCH_THRESHOLD = 5;

function scopeLabel(scopes: string[]): string[] {
  if (scopes.includes("apps:register") && scopes.includes("apps:deploy")) {
    return ["deploy"];
  }

  return scopes;
}

export function AppTokensTable({
  tokens,
  isLoading,
  error,
  onRevoke,
  isRevoking,
  isOwner,
}: AppTokensTableProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredTokens = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return tokens.filter(
      (token) =>
        (token.appName ?? "").toLowerCase().includes(query) ||
        (token.appSlug ?? "").toLowerCase().includes(query) ||
        token.tokenPrefix.toLowerCase().includes(query) ||
        scopeLabel(token.scopes).join(",").toLowerCase().includes(query),
    );
  }, [tokens, searchQuery]);

  const columns = useMemo<ColumnDef<AdminAppToken>[]>(() => {
    const base: ColumnDef<AdminAppToken>[] = [
      {
        id: "app",
        accessorFn: (token) => token.appName ?? "",
        header: ({ column }) => <SortableHeader column={column} label="App" />,
        meta: { cellClassName: "max-w-[280px]" },
        cell: ({ row }) => (
          <>
            <p className="truncate font-medium">
              {row.original.appName ?? "No app"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {row.original.appSlug ?? "Organization deploy token"}
            </p>
          </>
        ),
      },
      {
        id: "prefix",
        header: "Prefix",
        cell: ({ row }) => <TokenPrefix prefix={row.original.tokenPrefix} />,
      },
      {
        id: "scopes",
        header: "Scopes",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {scopeLabel(row.original.scopes).map((scope) => (
              <Badge key={scope} variant="secondary">
                {scope}
              </Badge>
            ))}
          </div>
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
        id: "lastUsed",
        accessorFn: (token) => dateSortValue(token.lastUsedAt, 0),
        header: ({ column }) => (
          <SortableHeader column={column} label="Last used" />
        ),
        meta: { cellClassName: "text-xs text-muted-foreground" },
        cell: ({ row }) => <DateCell value={row.original.lastUsedAt} />,
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
    ];
    if (!isOwner) return base;

    return [
      ...base,
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        meta: { headerClassName: "w-10" },
        // Only an active token has anything left to revoke.
        cell: ({ row }) =>
          tokenStatus(row.original) === "active" ? (
            <RowActionsMenu
              label={`Actions for token ${row.original.tokenPrefix}`}
            >
              <DropdownMenuItem
                variant="destructive"
                disabled={isRevoking}
                onClick={() => onRevoke(row.original)}
              >
                <Trash2 />
                Revoke token
              </DropdownMenuItem>
            </RowActionsMenu>
          ) : null,
      },
    ];
  }, [isOwner, isRevoking, onRevoke]);

  const table = useDataTable({
    data: filteredTokens,
    columns,
    getRowId: (token) => token.id,
    withSorting: true,
  });

  const isSearching = searchQuery !== "" && tokens.length > 0;

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      toolbar={
        tokens.length > SEARCH_THRESHOLD ? (
          <DataTableToolbar>
            <DataTableSearch
              label="Search tokens"
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </DataTableToolbar>
        ) : null
      }
      empty={
        isSearching
          ? {
              kind: "filtered",
              title: `No tokens match "${searchQuery}"`,
              action: (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSearchQuery("")}
                >
                  Clear search
                </Button>
              ),
            }
          : {
              title: "No deploy tokens yet",
              description: isOwner
                ? "Create one to authorize the CLI to deploy apps."
                : undefined,
            }
      }
    />
  );
}
