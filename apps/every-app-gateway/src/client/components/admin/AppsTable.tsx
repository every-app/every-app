import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Info } from "lucide-react";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import {
  DataTableSearch,
  DataTableToolbar,
} from "@/client/components/table/DataTableToolbar";
import { DateCell } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/client/components/ui/tooltip";
import type { AppWithAccessCount } from "@/types/app";
import { AppActionsMenu } from "./AppActionsMenu";

// The search box only shows once the catalog is long enough to need it.
const SEARCH_THRESHOLD = 3;

type AppRowActions = {
  onManageAccess: (app: AppWithAccessCount) => void;
  onEdit: (app: AppWithAccessCount) => void;
  onDelete: (app: AppWithAccessCount) => void;
  isOwner: boolean;
};

interface AppsTableProps extends AppRowActions {
  apps: AppWithAccessCount[];
  isLoading: boolean;
  /** A load failure. With no rows it replaces the table. */
  error?: ReactNode;
}

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

/**
 * The deploy state as a chip. An app is only reachable once it has a hostname
 * and its Worker is bound and active (see `AppListItem`).
 */
function appStatus(app: AppWithAccessCount): {
  label: string;
  variant: BadgeVariant;
} {
  if (!app.hostname || app.status === "pending") {
    return { label: "Needs deploy", variant: "outline" };
  }
  switch (app.status) {
    case "active":
      return { label: "Active", variant: "success" };
    case "binding":
      return { label: "Deploying", variant: "info" };
    case "disabled":
      return { label: "Disabled", variant: "secondary" };
    default:
      return { label: app.status, variant: "outline" };
  }
}

function AppNameCell({ app }: { app: AppWithAccessCount }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="truncate font-medium">{app.name}</p>
        {app.description ? (
          <Tooltip>
            <TooltipTrigger
              delay={150}
              aria-label={`About ${app.name}`}
              className="shrink-0 cursor-help text-muted-foreground transition-colors hover:text-foreground"
            >
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="right">{app.description}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {app.appId}
        {app.hostname ? ` · ${app.hostname}` : null}
      </p>
      {app.deployedByActor ? (
        <p className="truncate text-xs text-muted-foreground">
          Deployed by {app.deployedByActor}
        </p>
      ) : null}
    </>
  );
}

function buildColumns({
  onManageAccess,
  onEdit,
  onDelete,
  isOwner,
}: AppRowActions): ColumnDef<AppWithAccessCount>[] {
  return [
    {
      id: "app",
      accessorFn: (app) => app.name,
      header: ({ column }) => <SortableHeader column={column} label="App" />,
      cell: ({ row }) => <AppNameCell app={row.original} />,
      meta: { cellClassName: "max-w-[320px]" },
    },
    {
      id: "status",
      accessorFn: (app) => appStatus(app).label,
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      cell: ({ row }) => {
        const status = appStatus(row.original);
        return <Badge variant={status.variant}>{status.label}</Badge>;
      },
    },
    {
      id: "availableTo",
      accessorFn: (app) => app.isDefault,
      header: "Available to",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.isDefault ? (
          <Badge variant="success">Everyone</Badge>
        ) : (
          <Badge variant="secondary">Selected people</Badge>
        ),
    },
    {
      accessorKey: "accessCount",
      header: ({ column }) => <SortableHeader column={column} label="Access" />,
      cell: ({ row }) => {
        const count = row.original.accessCount;
        return (
          <Button
            variant="ghost"
            size="xs"
            className="-ml-2 tabular-nums"
            onClick={() => onManageAccess(row.original)}
          >
            {count} {count === 1 ? "user" : "users"}
          </Button>
        );
      },
    },
    {
      accessorKey: "updatedAt",
      header: ({ column }) => (
        <SortableHeader column={column} label="Updated" />
      ),
      sortingFn: "datetime",
      cell: ({ row }) => <DateCell value={row.original.updatedAt} />,
      meta: { cellClassName: "text-xs text-muted-foreground" },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row }) => (
        <AppActionsMenu
          appName={row.original.name}
          onManageAccess={() => onManageAccess(row.original)}
          onEdit={() => onEdit(row.original)}
          onDelete={() => onDelete(row.original)}
          isOwner={isOwner}
        />
      ),
    },
  ];
}

export function AppsTable({
  apps,
  isLoading,
  error,
  onManageAccess,
  onEdit,
  onDelete,
  isOwner,
}: AppsTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const showSearch = apps.length > SEARCH_THRESHOLD;
  // A hidden search box must not keep filtering, e.g. after a delete.
  const query = showSearch ? searchQuery.trim().toLowerCase() : "";

  const filteredApps = useMemo(
    () =>
      query
        ? apps.filter(
            (app) =>
              app.name.toLowerCase().includes(query) ||
              app.appId.toLowerCase().includes(query) ||
              app.description.toLowerCase().includes(query),
          )
        : apps,
    [apps, query],
  );

  // Stable columns and data keep TanStack Table from resetting every render.
  const columns = useMemo(
    () => buildColumns({ onManageAccess, onEdit, onDelete, isOwner }),
    [onManageAccess, onEdit, onDelete, isOwner],
  );

  const table = useDataTable({
    data: filteredApps,
    columns,
    getRowId: (app) => app.id,
    withSorting: true,
  });

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      toolbar={
        showSearch ? (
          <DataTableToolbar
            actions={
              query ? (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {filteredApps.length} of {apps.length}
                </span>
              ) : null
            }
          >
            <DataTableSearch
              label="Search apps"
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </DataTableToolbar>
        ) : null
      }
      empty={
        query
          ? {
              kind: "filtered",
              title: `No apps match "${searchQuery.trim()}"`,
              description: "Search by app name, app ID or description.",
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
              title: "No apps yet",
              description:
                "Apps show up here once you deploy them with the everyapp CLI.",
            }
      }
    />
  );
}
