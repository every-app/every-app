import type { ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell } from "@/client/components/table/DateCell";
import { Badge, type badgeVariants } from "@/client/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/client/components/ui/tooltip";
import type { ToolCallRow } from "@/types/activity";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

interface ToolCallsTableProps {
  calls: ToolCallRow[];
  /** The first load: skeleton rows under the headers. */
  isLoading: boolean;
  /** A load failure, shown above the rows (or in their place). */
  error?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  /** True when a filter narrows the list; an empty table then offers to clear them. */
  isFiltered: boolean;
  onClearFilters: () => void;
}

const CREDENTIAL_LABELS: Record<string, string> = {
  oauth: "OAuth",
  pat: "PAT",
  session: "Session",
  access: "Access",
  dev: "Dev",
};

/** How the caller authenticated: the OAuth client's own name, else the kind. */
function credentialLabel(credential: ToolCallRow["credential"]): string {
  if (credential.kind === "oauth" && credential.clientName) {
    return credential.clientName;
  }
  return CREDENTIAL_LABELS[credential.kind] ?? credential.kind;
}

const RISK_VARIANTS: Record<string, BadgeVariant> = {
  read: "secondary",
  write: "info",
  destructive: "destructive",
};

const OUTCOMES: Record<string, { label: string; className: string }> = {
  ok: { label: "OK", className: "text-muted-foreground" },
  tool_error: {
    label: "Tool error",
    className: "text-warning-foreground dark:text-warning",
  },
  invalid_arguments: {
    label: "Invalid arguments",
    className: "text-warning-foreground dark:text-warning",
  },
  app_error: { label: "App error", className: "text-destructive" },
  timeout: { label: "Timed out", className: "text-destructive" },
  unreachable: { label: "Unreachable", className: "text-destructive" },
  not_run: { label: "Not run", className: "text-muted-foreground" },
};

/** "read_only_caller" reads as "Read only caller". */
function humanize(code: string): string {
  const words = code.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function WhoCell({ call }: { call: ToolCallRow }) {
  const { user } = call;
  // No membership in this organization any more: by id, never by the
  // profile they keep elsewhere.
  const former = user.name === null && user.email === null;
  const secondary = former
    ? user.id
    : user.name && user.name !== user.email
      ? user.email
      : null;
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <p
          className={cn(
            "truncate",
            former ? "text-muted-foreground" : "font-medium",
          )}
        >
          {former ? "Former member" : user.name || user.email}
        </p>
        <Badge variant="outline" size="sm" className="shrink-0">
          {credentialLabel(call.credential)}
        </Badge>
      </div>
      {secondary ? (
        <p className="truncate text-xs text-muted-foreground">{secondary}</p>
      ) : null}
    </>
  );
}

function AppCell({ app }: { app: ToolCallRow["app"] }) {
  // A gateway-surface call that named no app (an unknown tool).
  if (!app.rowId && !app.slug) {
    return <span className="text-muted-foreground">—</span>;
  }
  // A deleted app keeps its name on its tombstone; one whose row is gone
  // shows by the slug the call recorded.
  const title = app.name ?? app.slug ?? app.rowId;
  const detail = app.removed ? "Removed app" : app.name ? app.slug : null;
  return (
    <>
      <p className="truncate font-medium">{title}</p>
      {detail ? (
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      ) : null}
    </>
  );
}

function ToolCell({ tool }: { tool: ToolCallRow["tool"] }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <p className="truncate font-mono text-xs">{tool.name}</p>
      {tool.risk ? (
        <Badge
          variant={RISK_VARIANTS[tool.risk] ?? "outline"}
          size="sm"
          className="shrink-0 capitalize"
        >
          {tool.risk}
        </Badge>
      ) : null}
    </div>
  );
}

function DecisionCell({ call }: { call: ToolCallRow }) {
  const allowed = call.decision === "allowed";
  const badge = (
    <Badge variant={allowed ? "success" : "destructive"}>
      {allowed ? "Allowed" : "Blocked"}
    </Badge>
  );
  if (!call.reason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        aria-label={`${allowed ? "Allowed" : "Blocked"}: ${humanize(call.reason)}`}
        className="cursor-help rounded-4xl"
      >
        {badge}
      </TooltipTrigger>
      <TooltipContent>{humanize(call.reason)}</TooltipContent>
    </Tooltip>
  );
}

function OutcomeCell({ outcome }: { outcome: string }) {
  const known = OUTCOMES[outcome];
  return (
    <span className={cn("text-sm", known?.className ?? "text-foreground")}>
      {known?.label ?? humanize(outcome)}
    </span>
  );
}

// The list is ordered on the server (newest first, across pages), so the
// columns don't sort: sorting one loaded page would mislead.
const columns: ColumnDef<ToolCallRow>[] = [
  {
    id: "when",
    header: "When",
    meta: { cellClassName: "whitespace-nowrap text-xs text-muted-foreground" },
    cell: ({ row }) => <DateCell value={row.original.createdAt} withTime />,
  },
  {
    id: "who",
    header: "Who",
    meta: { cellClassName: "max-w-[240px]" },
    cell: ({ row }) => <WhoCell call={row.original} />,
  },
  {
    id: "app",
    header: "App",
    meta: { cellClassName: "max-w-[200px]" },
    cell: ({ row }) => <AppCell app={row.original.app} />,
  },
  {
    id: "tool",
    header: "Tool",
    meta: { cellClassName: "max-w-[280px]" },
    cell: ({ row }) => <ToolCell tool={row.original.tool} />,
  },
  {
    id: "decision",
    header: "Decision",
    cell: ({ row }) => <DecisionCell call={row.original} />,
  },
  {
    id: "outcome",
    header: "Outcome",
    cell: ({ row }) => <OutcomeCell outcome={row.original.outcome} />,
  },
  {
    id: "duration",
    header: "Duration",
    meta: {
      headerClassName: "text-right",
      cellClassName:
        "whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground",
    },
    cell: ({ row }) => formatDuration(row.original.durationMs),
  },
  {
    id: "resultBytes",
    header: "Result size",
    meta: {
      headerClassName: "text-right",
      cellClassName:
        "whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground",
    },
    cell: ({ row }) => formatBytes(row.original.resultBytes),
  },
];

export function ToolCallsTable({
  calls,
  isLoading,
  error,
  toolbar,
  footer,
  isFiltered,
  onClearFilters,
}: ToolCallsTableProps) {
  const table = useDataTable({
    data: calls,
    columns,
    getRowId: (call) => call.id,
  });

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      toolbar={toolbar}
      footer={footer}
      isFiltered={isFiltered}
      onClearFilters={onClearFilters}
      empty={{
        title: "No agent tool calls yet",
        description: (
          <>
            Calls your AI apps make through the gateway&apos;s MCP are listed
            here, kept for <code>MCP_AUDIT_RETENTION_DAYS</code> (90 by
            default).
          </>
        ),
      }}
    />
  );
}
