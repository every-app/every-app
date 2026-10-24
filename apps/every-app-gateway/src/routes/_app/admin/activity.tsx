import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { ToolCallsTable } from "@/client/components/admin/ToolCallsTable";
import { DataTableToolbar } from "@/client/components/table/DataTableToolbar";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import {
  ACTIVITY_RANGE_ITEMS,
  DEFAULT_ACTIVITY_RANGE,
  toolCallAppLabel,
  toolCallsInfiniteQuery,
  type ActivityRange,
} from "@/client/lib/activity";
import { listToolCallApps, listToolCalls } from "@/serverFunctions/activity";

export const Route = createFileRoute("/_app/admin/activity")({
  component: ActivityPage,
});

const PAGE_SIZE = 50;

/** The "no filter" choice of a select. */
const ANY = "any";
type Decision = typeof ANY | "allowed" | "blocked";
type Risk = typeof ANY | "read" | "write" | "destructive";

const DECISION_ITEMS: { value: Decision; label: string }[] = [
  { value: ANY, label: "Any decision" },
  { value: "allowed", label: "Allowed" },
  { value: "blocked", label: "Blocked" },
];
const RISK_ITEMS: { value: Risk; label: string }[] = [
  { value: ANY, label: "Any risk" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "destructive", label: "Destructive" },
];

/** A single-choice filter in the table's toolbar. */
function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: string }[];
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        const picked = items.find((item) => item.value === next);
        if (picked) onChange(picked.value);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActivityPage() {
  const [appRowId, setAppRowId] = useState(ANY);
  const [decision, setDecision] = useState<Decision>(ANY);
  const [risk, setRisk] = useState<Risk>(ANY);
  const [range, setRange] = useState<ActivityRange>(DEFAULT_ACTIVITY_RANGE);

  // The apps the trail names, not the Apps list: a shared app's row belongs
  // to the platform organization, and a removed app is no longer listed.
  // The choices come from a group-by over the organization's whole trail,
  // so they are kept for a few minutes rather than read again on every
  // visit; a new app shows up in the list itself at once, and in the filter
  // on the next refresh.
  const { data: apps } = useQuery({
    queryKey: ["admin", "toolCallApps"],
    queryFn: () => listToolCallApps(),
    staleTime: 5 * 60_000,
    refetchOnMount: true,
  });
  const appItems = useMemo(
    () => [
      { value: ANY, label: "All apps" },
      ...(apps ?? [])
        .map((app) => ({ value: app.rowId, label: toolCallAppLabel(app) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [apps],
  );

  const query = useInfiniteQuery(
    // One query per filter set, so the window taken on its first page
    // outlives the render (see `toolCallsInfiniteQuery`).
    useMemo(
      () =>
        toolCallsInfiniteQuery(
          {
            appRowId: appRowId === ANY ? undefined : appRowId,
            decision: decision === ANY ? undefined : decision,
            risk: risk === ANY ? undefined : risk,
            range,
            limit: PAGE_SIZE,
          },
          (request) => listToolCalls({ data: request }),
        ),
      [appRowId, decision, risk, range],
    ),
  );
  const calls = useMemo(
    () => query.data?.pages.flatMap((page) => page.calls) ?? [],
    [query.data],
  );

  const isFiltered =
    appRowId !== ANY ||
    decision !== ANY ||
    risk !== ANY ||
    range !== DEFAULT_ACTIVITY_RANGE;
  const clearFilters = () => {
    setAppRowId(ANY);
    setDecision(ANY);
    setRisk(ANY);
    setRange(DEFAULT_ACTIVITY_RANGE);
  };

  const loadMore = async () => {
    const result = await query.fetchNextPage();
    if (result.isError) toast.error("Failed to load more tool calls");
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Agent activity"
        hint="Arguments and results are never stored."
      />

      <ToolCallsTable
        calls={calls}
        isLoading={query.isLoading}
        error={
          query.isError && calls.length === 0 ? (
            <ErrorState
              message="Couldn't load agent activity."
              onRetry={() => void query.refetch()}
              isRetrying={query.isFetching}
            />
          ) : null
        }
        isFiltered={isFiltered}
        onClearFilters={clearFilters}
        toolbar={
          <DataTableToolbar
            actions={
              <SegmentedToggle
                items={ACTIVITY_RANGE_ITEMS}
                value={range}
                onChange={setRange}
                showLabels
              />
            }
          >
            <FilterSelect
              label="App"
              value={appRowId}
              onChange={setAppRowId}
              items={appItems}
            />
            <FilterSelect
              label="Decision"
              value={decision}
              onChange={setDecision}
              items={DECISION_ITEMS}
            />
            <FilterSelect
              label="Risk"
              value={risk}
              onChange={setRisk}
              items={RISK_ITEMS}
            />
          </DataTableToolbar>
        }
        footer={
          calls.length > 0 ? (
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
              <span className="text-sm tabular-nums text-muted-foreground">
                Showing {calls.length} {calls.length === 1 ? "call" : "calls"}
              </span>
              {query.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  pending={query.isFetchingNextPage}
                  onClick={() => void loadMore()}
                >
                  Load more
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
    </div>
  );
}
