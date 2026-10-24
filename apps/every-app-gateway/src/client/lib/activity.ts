/** The Admin → Activity page's time window and its paged query. */
import type {
  ToolCallApp,
  ToolCallCursor,
  ToolCallsPage,
} from "@/types/activity";

const DAY_MS = 86_400_000;

export type ActivityRange = "24h" | "7d" | "30d" | "all";

/** How far back each range reaches; null for the whole retained trail. */
const RANGE_MS: Record<ActivityRange, number | null> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  all: null,
};

export const ACTIVITY_RANGE_ITEMS: {
  value: ActivityRange;
  icon: null;
  label: string;
}[] = [
  { value: "24h", icon: null, label: "24 h" },
  { value: "7d", icon: null, label: "7 d" },
  { value: "30d", icon: null, label: "30 d" },
  { value: "all", icon: null, label: "All time" },
];

// The whole retained trail is the default, so the empty state can say "no
// calls yet" rather than "none this month": the table keeps 90 days by
// default, three times the widest dated range.
export const DEFAULT_ACTIVITY_RANGE: ActivityRange = "all";

/** Where the range starts, in milliseconds, as of `now`; undefined for all time. */
export function windowStart(
  range: ActivityRange,
  now: number,
): number | undefined {
  const span = RANGE_MS[range];
  return span === null ? undefined : now - span;
}

interface ToolCallFilters {
  appRowId: string | undefined;
  decision: "allowed" | "blocked" | undefined;
  risk: "read" | "write" | "destructive" | undefined;
  range: ActivityRange;
  limit: number;
}

/** What one page's request carries to `listToolCalls`. */
interface ToolCallsPageRequest extends Omit<ToolCallFilters, "range"> {
  since: number | undefined;
  before: ToolCallCursor | undefined;
}

/**
 * The options of the page's `useInfiniteQuery`, for one set of filters.
 * The window's start is taken from the clock when the first page loads,
 * and the later pages of that load reuse it, so one load is one window:
 * a page further down never drops rows the first one counted. A refetch
 * (window focus, retry) starts at the first page again, so it takes the
 * window afresh and "last 24 h" stays the last 24 hours however long the
 * tab stays open. The key holds the range, never the clock.
 */
export function toolCallsInfiniteQuery(
  filters: ToolCallFilters,
  fetchPage: (request: ToolCallsPageRequest) => Promise<ToolCallsPage>,
  now: () => number = Date.now,
) {
  const { range, ...rest } = filters;
  let since: number | undefined;
  return {
    queryKey: ["admin", "toolCalls", filters] as const,
    initialPageParam: null as ToolCallCursor | null,
    getNextPageParam: (page: ToolCallsPage) => page.nextBefore,
    queryFn: ({ pageParam }: { pageParam: ToolCallCursor | null }) => {
      if (pageParam === null) since = windowStart(range, now());
      return fetchPage({ ...rest, since, before: pageParam ?? undefined });
    },
  };
}

/** The App filter's label: the name, else the slug, and "(removed)" once it is gone. */
export function toolCallAppLabel(app: ToolCallApp): string {
  const name = app.name ?? app.slug ?? app.rowId;
  return app.removed ? `${name} (removed)` : name;
}
