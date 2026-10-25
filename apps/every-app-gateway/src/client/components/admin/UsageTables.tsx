import { useMemo, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Progress } from "@/client/components/ui/progress";
import {
  formatCapProgress,
  formatCostMicros,
  formatCount,
  usageTargetLabel,
} from "@/client/lib/usage";
import type {
  UsageAppRow,
  UsageMemberRow,
  UsageTargetRow,
  UsageTotals,
} from "@/types/usage";

interface UsageTableProps<TRow> {
  rows: TRow[];
  /** The first load: skeleton rows under the headers. */
  isLoading: boolean;
  /** A load failure, shown above the rows (or in their place). */
  error?: ReactNode;
}

const NUMERIC = "text-right tabular-nums";

function Count({ value }: { value: number }) {
  return (
    <span className={value === 0 ? "text-muted-foreground" : undefined}>
      {formatCount(value)}
    </span>
  );
}

function Failures({ value }: { value: number }) {
  if (value === 0) return <span className="text-muted-foreground">0</span>;
  return <span className="text-destructive">{formatCount(value)}</span>;
}

function Cost({ micros }: { micros: number }) {
  return (
    <span className={micros === 0 ? "text-muted-foreground" : undefined}>
      {formatCostMicros(micros)}
    </span>
  );
}

/** The provider columns every table shares: calls, failures, tokens, cost. */
function providerColumns<TRow extends UsageTotals>(): ColumnDef<TRow>[] {
  return [
    {
      accessorKey: "calls",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider calls" />
      ),
      meta: {
        label: "Provider calls",
        headerClassName: NUMERIC,
        cellClassName: NUMERIC,
      },
      cell: ({ row }) => <Count value={row.original.calls} />,
    },
    {
      accessorKey: "failures",
      header: ({ column }) => (
        <SortableHeader column={column} label="Failures" />
      ),
      meta: {
        label: "Failures",
        headerClassName: NUMERIC,
        cellClassName: NUMERIC,
      },
      cell: ({ row }) => <Failures value={row.original.failures} />,
    },
    {
      accessorKey: "inputTokens",
      header: ({ column }) => (
        <SortableHeader column={column} label="Tokens in" />
      ),
      meta: {
        label: "Tokens in",
        headerClassName: NUMERIC,
        cellClassName: NUMERIC,
      },
      cell: ({ row }) => <Count value={row.original.inputTokens} />,
    },
    {
      accessorKey: "outputTokens",
      header: ({ column }) => (
        <SortableHeader column={column} label="Tokens out" />
      ),
      meta: {
        label: "Tokens out",
        headerClassName: NUMERIC,
        cellClassName: NUMERIC,
      },
      cell: ({ row }) => <Count value={row.original.outputTokens} />,
    },
    {
      accessorKey: "costMicros",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider cost" />
      ),
      meta: {
        label: "Provider cost",
        headerClassName: NUMERIC,
        cellClassName: NUMERIC,
      },
      cell: ({ row }) => <Cost micros={row.original.costMicros} />,
    },
  ];
}

function toolCallsColumn<
  TRow extends { toolCalls: number },
>(): ColumnDef<TRow> {
  return {
    accessorKey: "toolCalls",
    header: ({ column }) => (
      <SortableHeader column={column} label="Agent tool calls" />
    ),
    meta: {
      label: "Agent tool calls",
      headerClassName: NUMERIC,
      cellClassName: NUMERIC,
    },
    cell: ({ row }) => <Count value={row.original.toolCalls} />,
  };
}

/**
 * The organization's monthly cap on the app's provider calls: how far
 * into it the app is this month, or the cap alone for a past month (the
 * cap is on the current month), or "Unlimited". The button opens the
 * set/clear dialog. An app the organization can no longer call (deleted)
 * has no cap and no button.
 */
function MonthlyCapCell({
  row,
  isCurrentMonth,
  onSetCap,
}: {
  row: UsageAppRow;
  isCurrentMonth: boolean;
  onSetCap: (row: UsageAppRow) => void;
}) {
  const cap = row.monthlyCallCap;
  if (!row.callable) return null;
  const button = (label: string) => (
    <Button
      variant="ghost"
      size="xs"
      className="-mr-2"
      aria-label={`${label} monthly cap for ${row.name ?? row.appRowId}`}
      onClick={() => onSetCap(row)}
    >
      {label}
    </Button>
  );
  if (cap === null) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted-foreground">Unlimited</span>
        {button("Set cap")}
      </div>
    );
  }
  if (!isCurrentMonth) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span>{formatCount(cap)}</span>
        {button("Edit")}
      </div>
    );
  }
  const reached = row.calls >= cap;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className={reached ? "text-destructive" : undefined}>
          {formatCapProgress(row.calls, cap)}
        </span>
        {button("Edit")}
      </div>
      <Progress
        value={Math.min(row.calls, cap)}
        max={cap}
        aria-label={`${row.name ?? row.appRowId}: ${formatCapProgress(row.calls, cap)} provider calls this month`}
        className="w-28"
        indicatorClassName={reached ? "bg-destructive" : undefined}
      />
    </div>
  );
}

interface AppColumnOptions {
  /** The month shown is the current UTC month: progress toward the cap applies. */
  isCurrentMonth: boolean;
  /** Opens the set/clear dialog for the row's app. */
  onSetCap: (row: UsageAppRow) => void;
}

// TanStack Table renders each `cell` as a component, and columns rebuilt
// on every render would remount them: the member and provider columns are
// module-level arrays, and the app columns are memoized on their options.
function buildAppColumns({
  isCurrentMonth,
  onSetCap,
}: AppColumnOptions): ColumnDef<UsageAppRow>[] {
  return [
    ...appNameColumns,
    ...providerColumns<UsageAppRow>(),
    toolCallsColumn<UsageAppRow>(),
    {
      id: "monthlyCap",
      accessorFn: (row) => row.monthlyCallCap ?? Number.POSITIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column} label="Monthly cap" />
      ),
      meta: {
        label: "Monthly cap",
        headerClassName: NUMERIC,
        cellClassName: NUMERIC,
      },
      cell: ({ row }) => (
        <MonthlyCapCell
          row={row.original}
          isCurrentMonth={isCurrentMonth}
          onSetCap={onSetCap}
        />
      ),
    },
  ];
}

const appNameColumns: ColumnDef<UsageAppRow>[] = [
  {
    id: "app",
    accessorFn: (row) => row.name ?? row.appRowId,
    header: ({ column }) => <SortableHeader column={column} label="App" />,
    meta: { label: "App", cellClassName: "max-w-[280px]" },
    cell: ({ row }) =>
      row.original.name ? (
        <>
          <p
            className={
              row.original.callable
                ? "truncate font-medium"
                : "truncate font-medium text-muted-foreground"
            }
          >
            {row.original.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {row.original.callable
              ? row.original.appSlug
              : // Its tombstone keeps the name: the app itself was deleted.
                [row.original.appSlug, "deleted"].filter(Boolean).join(", ")}
          </p>
        </>
      ) : (
        <>
          <p className="truncate font-medium text-muted-foreground">
            Removed app
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {row.original.appRowId}
          </p>
        </>
      ),
  },
];

const memberColumns: ColumnDef<UsageMemberRow>[] = [
  {
    id: "member",
    accessorFn: (row) => row.name || row.email || row.userId || "",
    header: ({ column }) => <SortableHeader column={column} label="Member" />,
    meta: { label: "Member", cellClassName: "max-w-[280px]" },
    cell: ({ row }) => {
      const { userId, name, email } = row.original;
      // The apps' own calls: background work, or an identity that didn't verify.
      if (userId === "") {
        return (
          <>
            <p className="truncate font-medium">Background</p>
            <p className="truncate text-xs text-muted-foreground">
              Calls the apps made on their own
            </p>
          </>
        );
      }
      // No longer a member of this organization (or no longer a user):
      // by id, never by the profile they keep elsewhere.
      if (!name && !email) {
        return (
          <>
            <p className="truncate font-medium text-muted-foreground">
              Former member
            </p>
            <p className="truncate text-xs text-muted-foreground">{userId}</p>
          </>
        );
      }
      return (
        <>
          <p className="truncate font-medium">{name || email}</p>
          {name && name !== email ? (
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          ) : null}
        </>
      );
    },
  },
  ...providerColumns<UsageMemberRow>(),
  toolCallsColumn<UsageMemberRow>(),
];

const KIND_LABELS: Record<string, string> = {
  ai: "AI provider",
  capability: "Capability",
};

const targetColumns: ColumnDef<UsageTargetRow>[] = [
  {
    id: "target",
    accessorFn: (row) => `${row.kind} ${row.target}`,
    header: ({ column }) => <SortableHeader column={column} label="Provider" />,
    meta: { label: "Provider" },
    // The registry's name, as the setup dialog and Admin → Apps say it;
    // the id under it is what the manifest and `secret set` use.
    cell: ({ row }) => {
      const { kind, target } = row.original;
      const label = usageTargetLabel(kind, target);
      return (
        <>
          <div className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            <Badge variant={kind === "ai" ? "info" : "secondary"}>
              {KIND_LABELS[kind] ?? kind}
            </Badge>
          </div>
          {label !== target ? (
            <p className="truncate text-xs text-muted-foreground">{target}</p>
          ) : null}
        </>
      );
    },
  },
  ...providerColumns<UsageTargetRow>(),
];

export function UsageByAppTable({
  rows,
  isLoading,
  error,
  isCurrentMonth,
  onSetCap,
}: UsageTableProps<UsageAppRow> & AppColumnOptions) {
  const columns = useMemo(
    () => buildAppColumns({ isCurrentMonth, onSetCap }),
    [isCurrentMonth, onSetCap],
  );
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (row) => row.appRowId,
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      empty={{
        title: "No apps",
        description:
          "Apps this organization can call are listed here, with what they spent in the month.",
      }}
    />
  );
}

export function UsageByMemberTable({
  rows,
  isLoading,
  error,
}: UsageTableProps<UsageMemberRow>) {
  const table = useDataTable({
    data: rows,
    columns: memberColumns,
    getRowId: (row) => row.userId || "background",
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      empty={{
        title: "No member usage this month",
        description: "Nobody made a provider call or an agent tool call.",
      }}
    />
  );
}

export function UsageByTargetTable({
  rows,
  isLoading,
  error,
}: UsageTableProps<UsageTargetRow>) {
  const table = useDataTable({
    data: rows,
    columns: targetColumns,
    getRowId: (row) => `${row.kind}:${row.target}`,
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      empty={{
        title: "No provider calls this month",
        description: "No AI provider or capability was called.",
      }}
    />
  );
}
