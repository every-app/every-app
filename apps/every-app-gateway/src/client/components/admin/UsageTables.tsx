import type { ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { Badge } from "@/client/components/ui/badge";
import { formatCostMicros, formatCount } from "@/client/lib/usage";
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
      meta: { headerClassName: NUMERIC, cellClassName: NUMERIC },
      cell: ({ row }) => <Count value={row.original.calls} />,
    },
    {
      accessorKey: "failures",
      header: ({ column }) => (
        <SortableHeader column={column} label="Failures" />
      ),
      meta: { headerClassName: NUMERIC, cellClassName: NUMERIC },
      cell: ({ row }) => <Failures value={row.original.failures} />,
    },
    {
      accessorKey: "inputTokens",
      header: ({ column }) => (
        <SortableHeader column={column} label="Tokens in" />
      ),
      meta: { headerClassName: NUMERIC, cellClassName: NUMERIC },
      cell: ({ row }) => <Count value={row.original.inputTokens} />,
    },
    {
      accessorKey: "outputTokens",
      header: ({ column }) => (
        <SortableHeader column={column} label="Tokens out" />
      ),
      meta: { headerClassName: NUMERIC, cellClassName: NUMERIC },
      cell: ({ row }) => <Count value={row.original.outputTokens} />,
    },
    {
      accessorKey: "costMicros",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider cost" />
      ),
      meta: { headerClassName: NUMERIC, cellClassName: NUMERIC },
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
    meta: { headerClassName: NUMERIC, cellClassName: NUMERIC },
    cell: ({ row }) => <Count value={row.original.toolCalls} />,
  };
}

// The columns are module-level arrays: TanStack Table renders each `cell`
// as a component, and columns rebuilt on every render would remount them.
const appColumns: ColumnDef<UsageAppRow>[] = [
  {
    id: "app",
    accessorFn: (row) => row.name ?? row.appRowId,
    header: ({ column }) => <SortableHeader column={column} label="App" />,
    meta: { cellClassName: "max-w-[280px]" },
    cell: ({ row }) =>
      row.original.name ? (
        <>
          <p className="truncate font-medium">{row.original.name}</p>
          {row.original.appSlug ? (
            <p className="truncate text-xs text-muted-foreground">
              {row.original.appSlug}
            </p>
          ) : null}
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
  ...providerColumns<UsageAppRow>(),
  toolCallsColumn<UsageAppRow>(),
];

const memberColumns: ColumnDef<UsageMemberRow>[] = [
  {
    id: "member",
    accessorFn: (row) => row.name || row.email || row.userId || "",
    header: ({ column }) => <SortableHeader column={column} label="Member" />,
    meta: { cellClassName: "max-w-[280px]" },
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
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <span className="font-medium">{row.original.target}</span>
        <Badge variant={row.original.kind === "ai" ? "info" : "secondary"}>
          {KIND_LABELS[row.original.kind] ?? row.original.kind}
        </Badge>
      </div>
    ),
  },
  ...providerColumns<UsageTargetRow>(),
];

export function UsageByAppTable({
  rows,
  isLoading,
  error,
}: UsageTableProps<UsageAppRow>) {
  const table = useDataTable({
    data: rows,
    columns: appColumns,
    getRowId: (row) => row.appRowId,
    withSorting: true,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={error}
      empty={{
        title: "No app usage this month",
        description: "No app called a provider or served an agent tool call.",
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
