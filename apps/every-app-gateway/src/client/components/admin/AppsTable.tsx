import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Info } from "lucide-react";
import { EmptyState } from "@/client/components/EmptyState";
import {
  CardSlot,
  DataTable,
  useDataTable,
} from "@/client/components/table/DataTable";
import {
  DataTableSearch,
  DataTableToolbar,
} from "@/client/components/table/DataTableToolbar";
import { DATE_CELL, DateCell } from "@/client/components/table/DateCell";
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
  appNeedsSetup,
  appStatus,
  isRemoteMcpApp,
} from "@/client/lib/appStatus";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import type { AppWithAccessCount } from "@/types/app";
import { AppActionsMenu } from "./AppActionsMenu";
import { CountCell } from "./CountCell";
import { deployedBy } from "./deployedBy";

// The search box only shows once the catalog is long enough to need it.
const SEARCH_THRESHOLD = 3;

type AppColumn = ColumnDef<AppWithAccessCount>;
type OnApp = (app: AppWithAccessCount) => void;

type AppRowActions = {
  /** Opens the setup dialog, for an app that needs setup. */
  onSetup: OnApp;
  onManageAccess: OnApp;
  onEdit: OnApp;
  /** Deletes an app; removes an MCP app (owners and admins, either way). */
  onDelete: OnApp;
  isAdmin: boolean;
};

type McpAppRowActions = AppRowActions & {
  /** Opens the "Use it from your agent" dialog. */
  onUseMcp: OnApp;
  /** Turns an MCP app off when it is on, and on when it is off. */
  onToggleMcpStatus: OnApp;
};

function NameLine({ app }: { app: AppWithAccessCount }) {
  return (
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
  );
}

function AppNameCell({ app }: { app: AppWithAccessCount }) {
  return (
    <>
      <NameLine app={app} />
      <p className="truncate text-xs text-muted-foreground">
        {app.appId}
        {app.hostname ? ` · ${app.hostname}` : null}
      </p>
    </>
  );
}

function McpAppNameCell({ app }: { app: AppWithAccessCount }) {
  return (
    <>
      <NameLine app={app} />
      <p className="truncate text-xs text-muted-foreground">
        {app.appId} · agents call {app.appId}_&lt;tool&gt;
      </p>
    </>
  );
}

/**
 * How many members open the app now (effective-access.ts: everyone, a
 * role, a person's grant or a group's); "Available to everyone" is said
 * under it, since it covers people who join later too. Nobody is granted a
 * shared app: every organization has it.
 *
 * The hint is its own line in the table's column, and follows the count on
 * a phone's row, where the cell is one item of the line under the name.
 */
function WhoCell({
  app,
  onManageAccess,
}: {
  app: AppWithAccessCount;
  onManageAccess: OnApp;
}) {
  if (app.scope === "shared") {
    return (
      <span className="text-sm text-muted-foreground">Every organization</span>
    );
  }
  return (
    <>
      <CountCell
        count={app.accessCount}
        noun="user"
        aria-label={`Manage access to ${app.name}`}
        onClick={() => onManageAccess(app)}
      />
      {app.everyone ? (
        <>
          {" "}
          <span className="text-xs text-muted-foreground md:block">
            + everyone who joins
          </span>
        </>
      ) : null}
    </>
  );
}

function nameColumn(
  label: string,
  Cell: (props: { app: AppWithAccessCount }) => ReactNode,
): AppColumn {
  return {
    id: "name",
    accessorFn: (app) => app.name,
    header: ({ column }) => <SortableHeader column={column} label={label} />,
    cell: ({ row }) => <Cell app={row.original} />,
    meta: { label, cellClassName: "max-w-[320px]" },
  };
}

function statusColumn(onSetup: OnApp): AppColumn {
  return {
    id: "status",
    accessorFn: (app) => appStatus(app).label,
    header: ({ column }) => <SortableHeader column={column} label="Status" />,
    meta: { label: "Status", card: CardSlot.Trailing },
    cell: ({ row }) => {
      const status = appStatus(row.original);
      // The usual state is plain text; only an exception is a chip (as on
      // the Users and Tokens tabs).
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
  };
}

function whoColumn(label: string, onManageAccess: OnApp): AppColumn {
  return {
    id: "who",
    accessorFn: (app) => app.accessCount,
    header: ({ column }) => <SortableHeader column={column} label={label} />,
    meta: { label, card: CardSlot.BareDetail },
    cell: ({ row }) => (
      <WhoCell app={row.original} onManageAccess={onManageAccess} />
    ),
  };
}

/** When it last changed, and who is behind it in plain words. */
function updatedColumn(
  byLine: (actor: string, app: AppWithAccessCount) => string | null,
): AppColumn {
  return {
    accessorKey: "updatedAt",
    header: ({ column }) => <SortableHeader column={column} label="Updated" />,
    sortingFn: "datetime",
    cell: ({ row: { original: app } }) => (
      <>
        <DateCell value={app.updatedAt} />
        {app.deployedByActor ? (
          <p className="truncate text-xs">{byLine(app.deployedByActor, app)}</p>
        ) : null}
      </>
    ),
    meta: {
      label: "Updated",
      cellClassName: `${DATE_CELL} max-w-[240px]`,
      card: CardSlot.Hidden,
    },
  };
}

function actionsColumn(
  { onSetup, onManageAccess, onEdit, onDelete, isAdmin }: AppRowActions,
  mcp?: (
    app: AppWithAccessCount,
  ) => ComponentProps<typeof AppActionsMenu>["mcp"],
): AppColumn {
  return {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    enableSorting: false,
    meta: { headerClassName: "w-10" },
    // Another organization's shared app is listed, never managed here.
    cell: ({ row: { original: app } }) =>
      app.readOnly ? null : (
        <AppActionsMenu
          appName={app.name}
          onSetup={appNeedsSetup(app) ? () => onSetup(app) : undefined}
          onManageAccess={
            app.scope === "shared" ? undefined : () => onManageAccess(app)
          }
          onEdit={() => onEdit(app)}
          onDelete={() => onDelete(app)}
          mcp={mcp?.(app)}
          isAdmin={isAdmin}
        />
      ),
  };
}

/** One table of the Apps tab: its rows, with a search once there are enough. */
function CatalogTable({
  apps,
  columns,
  isLoading,
  error,
  searchLabel,
  noMatch,
  empty,
}: {
  apps: AppWithAccessCount[];
  columns: AppColumn[];
  isLoading: boolean;
  /** A load failure. With no rows it replaces the table. */
  error?: ReactNode;
  searchLabel: string;
  noMatch: (query: string) => string;
  empty: Pick<
    ComponentProps<typeof EmptyState>,
    "title" | "description" | "action"
  >;
}) {
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
              label={searchLabel}
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </DataTableToolbar>
        ) : null
      }
      empty={
        query ? { kind: "filtered", title: noMatch(searchQuery.trim()) } : empty
      }
    />
  );
}

/** The apps of Admin → Apps: everything with a page to open. */
export function AppsTable({
  apps,
  isLoading,
  error,
  onSetup,
  onManageAccess,
  onEdit,
  onDelete,
  onAddApp,
  isAdmin,
}: AppRowActions & {
  apps: AppWithAccessCount[];
  isLoading: boolean;
  error?: ReactNode;
  /** Opens the Add app chooser, the empty table's one action. */
  onAddApp: () => void;
}) {
  // Stable columns and data keep TanStack Table from resetting every render.
  const columns = useMemo(
    () => [
      nameColumn("App", AppNameCell),
      statusColumn(onSetup),
      whoColumn("Who can open", onManageAccess),
      // Its mail addresses and integrations are the Edit app dialog's, in full.
      updatedColumn((actor) => deployedBy(actor)),
      actionsColumn({ onSetup, onManageAccess, onEdit, onDelete, isAdmin }),
    ],
    [onSetup, onManageAccess, onEdit, onDelete, isAdmin],
  );
  return (
    <CatalogTable
      apps={apps}
      columns={columns}
      isLoading={isLoading}
      error={error}
      searchLabel="Search apps"
      noMatch={(query) => `No apps match "${query}"`}
      empty={{
        title: FIRST_SCREEN.empty.adminTableTitle,
        description: FIRST_SCREEN.empty.adminTableDescription,
        action: (
          <Button variant="outline" aria-haspopup="dialog" onClick={onAddApp}>
            {FIRST_SCREEN.addApp.button}
          </Button>
        ),
      }}
    />
  );
}

/**
 * The MCP apps of Admin → Apps: no page to open, so no one "opens" them and
 * their menu says how an agent uses one. Remove is the tombstone (`everyapp mcp
 * remove`); Turn off keeps everything and stops serving it (`mcp off`).
 */
export function McpAppsTable({
  apps,
  isLoading,
  onSetup,
  onUseMcp,
  onManageAccess,
  onEdit,
  onDelete,
  onToggleMcpStatus,
  isAdmin,
}: McpAppRowActions & {
  apps: AppWithAccessCount[];
  isLoading: boolean;
}) {
  const copy = MCP_APP_COPY.section;
  const columns = useMemo(
    () => [
      nameColumn(copy.nameColumn, McpAppNameCell),
      statusColumn(onSetup),
      whoColumn(copy.whoColumn, onManageAccess),
      // It has no deploy: someone added the remote server, or connected a
      // built-in one.
      updatedColumn((actor, app) =>
        isRemoteMcpApp(app) ? copy.addedBy(actor) : copy.connectedBy(actor),
      ),
      actionsColumn(
        { onSetup, onManageAccess, onEdit, onDelete, isAdmin },
        (app) => ({
          onUseMcp: () => onUseMcp(app),
          on: app.status === "active",
          onToggle: () => onToggleMcpStatus(app),
        }),
      ),
    ],
    [
      copy,
      onSetup,
      onUseMcp,
      onManageAccess,
      onEdit,
      onDelete,
      onToggleMcpStatus,
      isAdmin,
    ],
  );
  return (
    <CatalogTable
      apps={apps}
      columns={columns}
      isLoading={isLoading}
      searchLabel={copy.searchLabel}
      noMatch={copy.noMatch}
      empty={{ title: copy.empty }}
    />
  );
}
