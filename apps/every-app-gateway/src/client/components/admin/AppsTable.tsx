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
import { appEmail } from "@/client/lib/appEmail";
import {
  AppStatusLabel,
  MCP_APP_KIND_LABEL,
  appNeedsSetup,
  appStatus,
  isMcpApp,
} from "@/client/lib/appStatus";
import type { AppWithAccessCount } from "@/types/app";
import { AppActionsMenu } from "./AppActionsMenu";
import { integrationLabel } from "./integrationLabel";
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
  const email = appEmail(app);
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
      {app.deployedByActor ? (
        <p className="truncate text-xs text-muted-foreground">
          {/* An MCP app has no deploy: the operator turned it on. */}
          {mcp ? "Turned on by" : "Deployed by"} {app.deployedByActor}
        </p>
      ) : null}
      {email.senders.length || email.inbound.length ? (
        <p className="truncate text-xs text-muted-foreground">
          {[
            email.senders.length
              ? `Sends as ${email.senders.join(", ")}`
              : null,
            email.inbound.length
              ? `Receives ${email.inbound.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {app.capabilities.length ? (
        <p className="truncate text-xs text-muted-foreground">
          Integrations: {app.capabilities.map(integrationLabel).join(" · ")}
        </p>
      ) : null}
    </>
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
      id: "availableTo",
      accessorFn: (app) => app.isDefault,
      header: "Available to",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.scope === "shared" ? (
          <Badge variant="info">Every organization</Badge>
        ) : row.original.isDefault ? (
          <Badge variant="success">Everyone</Badge>
        ) : (
          <Badge variant="secondary">Selected people</Badge>
        ),
    },
    {
      accessorKey: "accessCount",
      header: ({ column }) => <SortableHeader column={column} label="Access" />,
      cell: ({ row }) => {
        // Nobody is granted a shared app; there is no access to manage.
        if (row.original.scope === "shared") {
          return <span className="text-sm text-muted-foreground">—</span>;
        }
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
