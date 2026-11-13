import { useMemo, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Gauge } from "lucide-react";
import { cn } from "cn";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  CardSlot,
  DataTable,
  useDataTable,
  useInDataTableCard,
} from "@/client/components/table/DataTable";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { useTableSearch } from "@/client/components/table/useTableSearch";
import { Badge } from "@/client/components/ui/badge";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { Progress } from "@/client/components/ui/progress";
import {
  formatCostCap,
  formatCostCapProgress,
  formatCostMicros,
  formatCount,
  usageTargetLabel,
} from "@/client/lib/usage";
import type {
  UsageAppRow,
  UsageMemberRow,
  UsageModelRow,
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
/** One width for every number column, so the tables on the page keep one rhythm. */
const NUMERIC_HEAD = `w-28 ${NUMERIC}`;

function Count({ value }: { value: number }) {
  return (
    <span className={value === 0 ? "text-muted-foreground" : undefined}>
      {formatCount(value)}
    </span>
  );
}

/**
 * A number with a second one under it ("12 failed", "910,002 out"), or after
 * it on a phone's row, where a cell is one line.
 */
function Stacked({ top, under }: { top: ReactNode; under: ReactNode }) {
  const inCard = useInDataTableCard();
  if (!under) return top;
  return inCard ? (
    <>
      {top} · {under}
    </>
  ) : (
    <>
      <p>{top}</p>
      <p className="text-xs">{under}</p>
    </>
  );
}

/** Provider calls, and how many failed when any did. */
function Calls({ calls, failures }: { calls: number; failures: number }) {
  return (
    <Stacked
      top={<Count value={calls} />}
      under={
        failures > 0 ? (
          <span className="text-destructive">
            {formatCount(failures)} failed
          </span>
        ) : null
      }
    />
  );
}

/** Tokens sent to the provider, and the tokens it sent back under them. */
function Tokens({ input, output }: { input: number; output: number }) {
  if (input === 0 && output === 0) return <Count value={0} />;
  return (
    <Stacked
      top={<>{formatCount(input)} in</>}
      under={
        <span className="text-muted-foreground">{formatCount(output)} out</span>
      }
    />
  );
}

function Cost({ micros }: { micros: number }) {
  return (
    <span
      className={micros === 0 ? "text-muted-foreground" : "text-foreground"}
    >
      {formatCostMicros(micros)}
    </span>
  );
}

/**
 * The provider columns every table shares: calls (with failures), tokens (in
 * and out) and cost. On a phone's row the cost is the value on the right and
 * the counts are the line under the name, with short labels.
 */
function providerColumns<TRow extends UsageTotals>(): ColumnDef<TRow>[] {
  return [
    {
      accessorKey: "calls",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider calls" />
      ),
      meta: {
        label: "Calls",
        headerClassName: NUMERIC_HEAD,
        cellClassName: NUMERIC,
      },
      cell: ({ row }) => (
        <Calls calls={row.original.calls} failures={row.original.failures} />
      ),
    },
    {
      id: "tokens",
      accessorFn: (row) => row.inputTokens + row.outputTokens,
      header: ({ column }) => <SortableHeader column={column} label="Tokens" />,
      meta: {
        label: "Tokens",
        headerClassName: NUMERIC_HEAD,
        cellClassName: `${NUMERIC} whitespace-nowrap`,
      },
      cell: ({ row }) => (
        <Tokens
          input={row.original.inputTokens}
          output={row.original.outputTokens}
        />
      ),
    },
    {
      accessorKey: "costMicros",
      header: ({ column }) => (
        <SortableHeader
          column={column}
          label="Provider cost"
          helpText="Shown only when the provider reports its cost."
        />
      ),
      meta: {
        label: "Provider cost",
        headerClassName: NUMERIC_HEAD,
        cellClassName: NUMERIC,
        card: CardSlot.Trailing,
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
      label: "Tool calls",
      headerClassName: NUMERIC_HEAD,
      cellClassName: NUMERIC,
    },
    cell: ({ row }) => <Count value={row.original.toolCalls} />,
  };
}

/**
 * The Monthly cap cell: the same shape on every row. A line of text, and
 * under it a bar while a cap binds this month. The text is how far into the
 * cap the app is ("$4.20 of $20.00"), the cap alone for a past month (the
 * counts are the current month's), or "No cap". A paused app's text and bar
 * are red. A deleted app has no cell, and an MCP server added by URL, which
 * isn't metered, reads "Not metered". On a phone's row the cell spans the
 * row: the bar stretches and the text follows it.
 */
function MonthlyCapCell({
  row,
  isCurrentMonth,
}: {
  row: UsageAppRow;
  isCurrentMonth: boolean;
}) {
  if (!row.callable) return null;
  if (!row.metered) {
    return <span className="text-muted-foreground">Not metered</span>;
  }
  const cap = row.effectiveMonthlyCostCapMicros;
  const progress =
    cap !== null && isCurrentMonth
      ? formatCostCapProgress(row.costMicros, cap)
      : null;
  const value = cap === null ? "No cap" : (progress ?? formatCostCap(cap));
  return (
    <div className="flex flex-col items-end gap-1 max-md:flex-row-reverse max-md:items-center max-md:gap-3">
      <span
        className={cn(
          "shrink-0 whitespace-nowrap tabular-nums",
          row.paused
            ? "text-destructive"
            : cap === null
              ? "text-muted-foreground"
              : undefined,
        )}
      >
        {value}
      </span>
      {progress && cap !== null ? (
        <Progress
          value={Math.min(row.costMicros, cap)}
          max={cap}
          aria-label={`${row.name ?? row.appRowId}: ${progress} of provider-reported cost this month`}
          className="w-full min-w-28 max-md:flex-1"
          indicatorClassName={row.paused ? "bg-destructive" : undefined}
        />
      ) : null}
    </div>
  );
}

interface AppColumnOptions {
  /** The month shown is the current UTC month: progress toward the cap applies. */
  isCurrentMonth: boolean;
  /** Opens the cap dialog for the row's app. */
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
      accessorFn: (row) =>
        row.effectiveMonthlyCostCapMicros ?? Number.POSITIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column} label="Monthly cap" />
      ),
      meta: {
        label: "Monthly cap",
        headerClassName: NUMERIC,
        cellClassName: NUMERIC,
        card: CardSlot.Footer,
      },
      cell: ({ row }) => (
        <MonthlyCapCell row={row.original} isCurrentMonth={isCurrentMonth} />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      // A deleted app has nothing to cap, and an unmetered one isn't counted.
      cell: ({ row }) =>
        row.original.callable && row.original.metered ? (
          <RowActionsMenu
            label={`Actions for ${row.original.name ?? row.original.appRowId}`}
          >
            <DropdownMenuItem onClick={() => onSetCap(row.original)}>
              <Gauge />
              Edit monthly cap
            </DropdownMenuItem>
          </RowActionsMenu>
        ) : null,
    },
  ];
}

function appSearchText(row: UsageAppRow) {
  return [row.name ?? "Removed app", row.appSlug, row.appRowId];
}

function memberSearchText(row: UsageMemberRow) {
  return [row.userId === "" ? "Background" : row.name, row.email, row.userId];
}

function targetSearchText(row: UsageTargetRow) {
  return [
    usageTargetLabel(row.kind, row.target),
    row.target,
    KIND_LABELS[row.kind],
  ];
}

function modelSearchText(row: UsageModelRow) {
  return [row.model, usageTargetLabel("ai", row.provider)];
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
            <Badge variant="secondary">{KIND_LABELS[kind] ?? kind}</Badge>
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

const modelColumns: ColumnDef<UsageModelRow>[] = [
  {
    id: "model",
    accessorFn: (row) => `${row.model} ${row.provider}`,
    header: ({ column }) => <SortableHeader column={column} label="Model" />,
    meta: { label: "Model", cellClassName: "max-w-[320px]" },
    cell: ({ row }) => (
      <>
        <p className="truncate font-medium">{row.original.model}</p>
        <p className="truncate text-xs text-muted-foreground">
          {usageTargetLabel("ai", row.original.provider)}
        </p>
      </>
    ),
  },
  ...providerColumns<UsageModelRow>(),
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
  const search = useTableSearch(rows, appSearchText, "apps");
  const table = useDataTable({
    data: search.rows,
    columns,
    getRowId: (row) => row.appRowId,
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      search={search.search}
      empty={{ title: "No apps" }}
    />
  );
}

export function UsageByMemberTable({
  rows,
  isLoading,
  error,
}: UsageTableProps<UsageMemberRow>) {
  const search = useTableSearch(rows, memberSearchText, "members");
  const table = useDataTable({
    data: search.rows,
    columns: memberColumns,
    getRowId: (row) => row.userId || "background",
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      search={search.search}
      empty={{ title: "No member usage this month" }}
    />
  );
}

export function UsageByTargetTable({
  rows,
  isLoading,
  error,
}: UsageTableProps<UsageTargetRow>) {
  const search = useTableSearch(rows, targetSearchText, "providers");
  const table = useDataTable({
    data: search.rows,
    columns: targetColumns,
    getRowId: (row) => `${row.kind}:${row.target}`,
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      search={search.search}
      empty={{ title: "No provider calls this month" }}
    />
  );
}

export function UsageByModelTable({
  rows,
  isLoading,
  error,
}: UsageTableProps<UsageModelRow>) {
  const search = useTableSearch(rows, modelSearchText, "models");
  const table = useDataTable({
    data: search.rows,
    columns: modelColumns,
    getRowId: (row) => `${row.provider}:${row.model}`,
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      search={search.search}
      empty={{ title: "No model calls this month" }}
    />
  );
}
