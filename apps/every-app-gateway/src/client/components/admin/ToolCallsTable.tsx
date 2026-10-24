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
  pat: "Token",
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
  ok: { label: "OK", className: "text-foreground" },
  tool_error: { label: "Tool error", className: "text-destructive" },
  invalid_arguments: {
    label: "Invalid arguments",
    className: "text-destructive",
  },
  app_error: { label: "App error", className: "text-destructive" },
  timeout: { label: "Timed out", className: "text-destructive" },
  unreachable: { label: "Unreachable", className: "text-destructive" },
  not_run: { label: "Not run", className: "text-muted-foreground" },
};

/** Why a call was blocked, in plain words. */
const REASON_LABELS: Record<string, string> = {
  destructive_requires_approval:
    "Destructive tools are never available to AI apps",
  org_blocked: "Blocked by the organization",
  read_only_connection: "This connection is read-only",
  unknown_tool: "No such tool",
  write_via_read_wrapper:
    "This tool changes data; it is called through everyapp_call_write",
};

/** A reason with no label: "some_reason" reads as "Some reason". */
function humanize(code: string): string {
  const words = code.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? humanize(reason);
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function WhoCell({ call }: { call: ToolCallRow }) {
  const { user, credential } = call;
  // No membership in this organization any more: by id, never by the
  // profile they keep elsewhere.
  const former = user.name === null && user.email === null;
  const who = former
    ? user.id
    : user.name && user.name !== user.email
      ? user.email
      : null;
  const label = credentialLabel(credential);
  // What the AI app called itself in the MCP handshake (never verified):
  // for a token or Access caller the badge only names the credential's
  // kind, so this is what says which app called. Shown when it adds to
  // the badge, and in full on the badge's hover.
  const client =
    credential.clientInfo && credential.clientInfo !== label
      ? credential.clientInfo
      : null;
  const secondary = [who, client].filter(Boolean).join(" · ");
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
        <Badge
          variant="outline"
          size="sm"
          className="shrink-0"
          title={
            credential.clientInfo
              ? `${credential.clientInfo} (as the AI app named itself; not verified)`
              : undefined
          }
        >
          {label}
        </Badge>
      </div>
      {secondary ? (
        <p className="truncate text-xs text-muted-foreground" title={secondary}>
          {secondary}
        </p>
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
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="truncate font-mono text-xs" title={tool.name}>
          {tool.name}
        </p>
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
      {tool.via ? (
        // The call came through a wrapper built-in (a connection that
        // lists its tools compactly): the row names the inner tool, and
        // this says how it was reached.
        <p
          className="truncate text-xs text-muted-foreground"
          title={`Called through ${tool.via}`}
        >
          via <span className="font-mono">{tool.via}</span>
        </p>
      ) : null}
    </>
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
  const reason = reasonLabel(call.reason);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        aria-label={`${allowed ? "Allowed" : "Blocked"}: ${reason}`}
        className="cursor-help rounded-4xl"
      >
        {badge}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
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
//
// The when, decision, outcome and duration cells never wrap, so they take
// what their text needs (about 470 px); the who, app and tool cells are
// capped so the table fits a 942 px card at a 1280 px viewport and their
// text truncates rather than pushing the last column out of view.
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
    meta: { cellClassName: "max-w-[192px]" },
    cell: ({ row }) => <WhoCell call={row.original} />,
  },
  {
    id: "app",
    header: "App",
    meta: { cellClassName: "max-w-[116px]" },
    cell: ({ row }) => <AppCell app={row.original.app} />,
  },
  {
    id: "tool",
    header: "Tool",
    meta: { cellClassName: "max-w-[167px]" },
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
    meta: { cellClassName: "whitespace-nowrap" },
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
        description:
          "Tool calls AI apps make through the gateway show up here.",
      }}
    />
  );
}
