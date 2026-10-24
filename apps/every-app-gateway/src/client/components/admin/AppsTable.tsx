import { useMemo, useState, type ReactNode } from "react";
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
import {
  AppStatusLabel,
  MCP_APP_KIND_LABEL,
  appNeedsSetup,
  appStatus,
  isMcpApp,
} from "@/client/lib/appStatus";
import type { AppWithAccessCount } from "@/types/app";
import { AppActionsMenu } from "./AppActionsMenu";
import { CountCell } from "./CountCell";
import { deployedBy } from "./deployedBy";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";

// The search box only shows once the catalog is long enough to need it.
const SEARCH_THRESHOLD = 3;

type AppRowActions = {
  /** Opens the setup dialog, for an app that needs setup. */
  onSetup: (app: AppWithAccessCount) => void;
  /** Opens the "Use it from your agent" dialog, for an MCP app. */
  onUseMcp: (app: AppWithAccessCount) => void;
  onManageAccess: (app: AppWithAccessCount) => void;
  onEdit: (app: AppWithAccessCount) => void;
  onDelete: (app: AppWithAccessCount) => void;
  /** Opens the Add app chooser, the empty table's one action. */
  onAddApp?: () => void;
  isOwner: boolean;
};

interface AppsTableProps extends AppRowActions {
  apps: AppWithAccessCount[];
  isLoading: boolean;
  /** A load failure. With no rows it replaces the table. */
  error?: ReactNode;
}

function AppNameCell({
  app,
  onUseMcp,
}: {
  app: AppWithAccessCount;
  onUseMcp: (app: AppWithAccessCount) => void;
}) {
  const mcp = isMcpApp(app);
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="truncate font-medium">{app.name}</p>
        {mcp ? (
          // The kind, beside the name (never a status): it opens the
          // dialog that says how an agent uses the app.
          <Badge
            variant="soft"
            render={<button type="button" />}
            aria-haspopup="dialog"
            // The visible label first, then the action it opens.
            aria-label={`MCP. Use ${app.name} from your agent`}
            className="cursor-pointer hover:bg-primary/20"
            onClick={() => onUseMcp(app)}
          >
            {MCP_APP_KIND_LABEL}
          </Badge>
        ) : null}
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
        {app.hostname
          ? ` · ${app.hostname}`
          : mcp
            ? ` · agents call ${app.appId}_<tool>`
            : null}
      </p>
      {/* Who deployed it, in plain words; its mail addresses and
          integrations are the Edit app dialog's, in full. */}
      {app.deployedByActor ? (
        <p className="truncate text-xs text-muted-foreground">
          {/* An MCP app has no deploy: the operator turned it on. */}
          {mcp
            ? `Turned on by ${app.deployedByActor}`
            : deployedBy(app.deployedByActor)}
        </p>
      ) : null}
    </>
  );
}

/**
 * The grants are what the gateway checks, so the count is the truth;
 * "Available to everyone" is an auto-grant to each member as they join,
 * said under it. Nobody is granted a shared app: every organization has it.
 */
function WhoCanOpenCell({
  app,
  onManageAccess,
}: {
  app: AppWithAccessCount;
  onManageAccess: (app: AppWithAccessCount) => void;
}) {
  if (app.scope === "shared") {
    return (
      <span className="text-sm text-muted-foreground">Every organization</span>
    );
  }
  return (
    <div className="flex flex-col items-start">
      <CountCell
        count={app.accessCount}
        noun="user"
        aria-label={`Manage access to ${app.name}`}
        onClick={() => onManageAccess(app)}
      />
      {app.isDefault ? (
        <span className="text-xs text-muted-foreground">
          + everyone who joins
        </span>
      ) : null}
    </div>
  );
}

function buildColumns({
  onSetup,
  onUseMcp,
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
      cell: ({ row }) => <AppNameCell app={row.original} onUseMcp={onUseMcp} />,
      meta: { cellClassName: "max-w-[320px]" },
    },
    {
      id: "status",
      accessorFn: (app) => appStatus(app).label,
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      cell: ({ row }) => {
        const status = appStatus(row.original);
        // The usual state is plain text; only an exception is a chip (as
        // on the Users and Tokens tabs). An MCP app that is set up is
        // Active like any other; its kind is the chip beside its name.
        if (status.label === AppStatusLabel.Active) {
          return <span className="text-muted-foreground">{status.label}</span>;
        }
        // "Needs setup" opens the dialog that says what, even for a shared
        // app this organization can't fix (it says who does).
        if (appNeedsSetup(row.original)) {
          return (
            <Badge
              variant={status.variant}
              render={<button type="button" />}
              aria-haspopup="dialog"
              className="cursor-pointer hover:bg-warning/25"
              onClick={() => onSetup(row.original)}
            >
              {status.label}
            </Badge>
          );
        }
        return <Badge variant={status.variant}>{status.label}</Badge>;
      },
    },
    {
      id: "whoCanOpen",
      accessorFn: (app) => app.accessCount,
      header: ({ column }) => (
        <SortableHeader column={column} label="Who can open" />
      ),
      cell: ({ row }) => (
        <WhoCanOpenCell app={row.original} onManageAccess={onManageAccess} />
      ),
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
      // Another organization's shared app is listed, never managed here.
      cell: ({ row }) =>
        row.original.readOnly ? null : (
          <AppActionsMenu
            appName={row.original.name}
            onSetup={
              appNeedsSetup(row.original)
                ? () => onSetup(row.original)
                : undefined
            }
            onManageAccess={
              row.original.scope === "shared"
                ? undefined
                : () => onManageAccess(row.original)
            }
            onEdit={() => onEdit(row.original)}
            onDelete={() => onDelete(row.original)}
            // Deleting an MCP app's row is turning it off (`everyapp mcp
            // off` writes the same tombstone; `mcp on` brings it back).
            deleteLabel={isMcpApp(row.original) ? "Turn off" : undefined}
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
  onSetup,
  onUseMcp,
  onManageAccess,
  onEdit,
  onDelete,
  onAddApp,
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
    () =>
      buildColumns({
        onSetup,
        onUseMcp,
        onManageAccess,
        onEdit,
        onDelete,
        isOwner,
      }),
    [onSetup, onUseMcp, onManageAccess, onEdit, onDelete, isOwner],
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
          ? { kind: "filtered", title: `No apps match "${searchQuery.trim()}"` }
          : {
              title: FIRST_SCREEN.empty.adminTableTitle,
              description: FIRST_SCREEN.empty.adminTableDescription,
              action: onAddApp ? (
                <Button
                  variant="outline"
                  aria-haspopup="dialog"
                  onClick={onAddApp}
                >
                  {FIRST_SCREEN.addApp.button}
                </Button>
              ) : undefined,
            }
      }
    />
  );
}
