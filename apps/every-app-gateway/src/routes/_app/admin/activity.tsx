import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { auditActorLabel } from "@every-app/sdk/internal";
import { toast } from "sonner";
import { z } from "zod";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { AuditTable } from "@/client/components/admin/AuditTable";
import { ToolCallsTable } from "@/client/components/admin/ToolCallsTable";
import { DataTableToolbar } from "@/client/components/table/DataTableToolbar";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { auditInfiniteQuery, auditTypeItems } from "@/client/lib/audit";
import { listToolCallApps, listToolCalls } from "@/serverFunctions/activity";
import { listAuditActors, listAuditEvents } from "@/serverFunctions/audit";

/** `?view=audit` opens the audit log; anything else (or nothing) the tool calls. */
const searchSchema = z.object({
  view: z.enum(["agent", "audit"]).optional().catch(undefined),
});
type View = "agent" | "audit";

export const Route = createFileRoute("/_app/admin/activity")({
  validateSearch: searchSchema,
  component: ActivityPage,
});

const PAGE_SIZE = 50;

/** The "no filter" choice of a select. */
const ANY = "any";
type Decision = typeof ANY | "allowed" | "blocked";
type Risk = typeof ANY | "read" | "write" | "destructive";

const DECISION_ITEMS: { value: Decision; label: string }[] = [
  { value: ANY, label: "All decisions" },
  { value: "allowed", label: "Allowed" },
  { value: "blocked", label: "Blocked" },
];
const RISK_ITEMS: { value: Risk; label: string }[] = [
  { value: ANY, label: "All risks" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "destructive", label: "Destructive" },
];
const VIEW_ITEMS: { value: View; icon: null; label: string }[] = [
  { value: "agent", icon: null, label: "Agent activity" },
  { value: "audit", icon: null, label: "Audit" },
];

/** A single-choice filter in the table's toolbar. */
function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  items,
  groups,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: string }[];
  /** Grouped choices under headings, listed after `items`. */
  groups?: { group: string; items: { value: T; label: string }[] }[];
}) {
  const every = useMemo(
    () => [...items, ...(groups ?? []).flatMap((group) => group.items)],
    [items, groups],
  );
  return (
    <Select
      items={every}
      value={value}
      onValueChange={(next) => {
        const picked = every.find((item) => item.value === next);
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
        {(groups ?? []).map((group) => (
          <SelectGroup key={group.group}>
            <SelectLabel>{group.group}</SelectLabel>
            {group.items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActivityPage() {
  const search = useSearch({ from: "/_app/admin/activity" });
  const navigate = useNavigate();
  const view: View = search.view === "audit" ? "audit" : "agent";
  // The range is one setting for both views, so switching keeps it.
  const [range, setRange] = useState<ActivityRange>(DEFAULT_ACTIVITY_RANGE);
  const setView = (next: View) =>
    void navigate({
      to: "/admin/activity",
      search: next === "audit" ? { view: "audit" } : {},
      replace: true,
    });

  return (
    <div className="space-y-6">
      <SectionHeader
        title={view === "audit" ? "Audit log" : "Agent activity"}
        hint={
          view === "audit"
            ? "What happened in the workspace and who did it, kept 90 days. Never an event's data."
            : "Arguments and results are never stored."
        }
        action={
          <SegmentedToggle
            items={VIEW_ITEMS}
            value={view}
            onChange={setView}
            showLabels
          />
        }
      />
      {view === "audit" ? (
        <AuditView range={range} setRange={setRange} />
      ) : (
        <ToolCallsView range={range} setRange={setRange} />
      )}
    </div>
  );
}

interface ViewProps {
  range: ActivityRange;
  setRange: (range: ActivityRange) => void;
}

function RangeToggle({ range, setRange }: ViewProps): ReactNode {
  return (
    <SegmentedToggle
      items={ACTIVITY_RANGE_ITEMS}
      value={range}
      onChange={setRange}
      showLabels
    />
  );
}

function ToolCallsView({ range, setRange }: ViewProps) {
  const [appRowId, setAppRowId] = useState(ANY);
  const [decision, setDecision] = useState<Decision>(ANY);
  const [risk, setRisk] = useState<Risk>(ANY);

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
          actions={<RangeToggle range={range} setRange={setRange} />}
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
  );
}

const TYPE_GROUPS = auditTypeItems();

function AuditView({ range, setRange }: ViewProps) {
  const [actorId, setActorId] = useState(ANY);
  const [type, setType] = useState(ANY);

  // Whom the trail names, from a group-by over the organization's whole
  // trail: kept a few minutes like the tool calls' App filter.
  const { data: actors } = useQuery({
    queryKey: ["admin", "auditActors"],
    queryFn: () => listAuditActors(),
    staleTime: 5 * 60_000,
    refetchOnMount: true,
  });
  const actorItems = useMemo(
    () => [
      { value: ANY, label: "Everyone" },
      // The gateway's own rows have no actor id to filter by.
      ...(actors ?? [])
        .filter((actor) => actor.id !== null)
        .map((actor) => ({
          value: actor.id!,
          label: auditActorLabel(actor),
        })),
    ],
    [actors],
  );

  const query = useInfiniteQuery(
    useMemo(
      () =>
        auditInfiniteQuery(
          {
            actorId: actorId === ANY ? undefined : actorId,
            type: type === ANY ? undefined : type,
            range,
            limit: PAGE_SIZE,
          },
          (request) => listAuditEvents({ data: request }),
        ),
      [actorId, type, range],
    ),
  );
  const events = useMemo(
    () => query.data?.pages.flatMap((page) => page.events) ?? [],
    [query.data],
  );

  const isFiltered =
    actorId !== ANY || type !== ANY || range !== DEFAULT_ACTIVITY_RANGE;
  const clearFilters = () => {
    setActorId(ANY);
    setType(ANY);
    setRange(DEFAULT_ACTIVITY_RANGE);
  };

  const loadMore = async () => {
    const result = await query.fetchNextPage();
    if (result.isError) toast.error("Failed to load more audit events");
  };

  return (
    <AuditTable
      events={events}
      isLoading={query.isLoading}
      error={
        query.isError && events.length === 0 ? (
          <ErrorState
            message="Couldn't load the audit log."
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : null
      }
      isFiltered={isFiltered}
      onClearFilters={clearFilters}
      toolbar={
        <DataTableToolbar
          actions={<RangeToggle range={range} setRange={setRange} />}
        >
          <FilterSelect
            label="Who"
            value={actorId}
            onChange={setActorId}
            items={actorItems}
          />
          <FilterSelect
            label="Type"
            value={type}
            onChange={setType}
            items={[
              { value: ANY, label: "All events" },
              { value: "*", label: "Everything, pings and tool calls too" },
            ]}
            groups={TYPE_GROUPS}
          />
        </DataTableToolbar>
      }
      footer={
        events.length > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
            <span className="text-sm tabular-nums text-muted-foreground">
              Showing {events.length} {events.length === 1 ? "event" : "events"}
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
  );
}
