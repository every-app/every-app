/** The Admin → Activity → Audit view's paged query and its filter choices. */
import { auditTypeGroups } from "@every-app/sdk/internal";
import type { AuditCursor, AuditPage } from "@/types/audit";
import { windowStart, type ActivityRange } from "./activity";

interface AuditFilters {
  actorId: string | undefined;
  /** A type, a prefix (`member.*`) or `*`; undefined leaves ping and tool.* out. */
  type: string | undefined;
  range: ActivityRange;
  limit: number;
}

/** What one page's request carries to `listAuditEvents`. */
interface AuditPageRequest extends Omit<AuditFilters, "range"> {
  since: number | undefined;
  before: AuditCursor | undefined;
}

/**
 * The options of the view's `useInfiniteQuery`, for one set of filters:
 * the window is taken from the clock when the first page loads and the
 * later pages reuse it, as `toolCallsInfiniteQuery` does.
 */
export function auditInfiniteQuery(
  filters: AuditFilters,
  fetchPage: (request: AuditPageRequest) => Promise<AuditPage>,
  now: () => number = Date.now,
) {
  const { range, ...rest } = filters;
  let since: number | undefined;
  return {
    queryKey: ["admin", "audit", filters] as const,
    initialPageParam: null as AuditCursor | null,
    getNextPageParam: (page: AuditPage) => page.nextBefore,
    queryFn: ({ pageParam }: { pageParam: AuditCursor | null }) => {
      if (pageParam === null) since = windowStart(range, now());
      return fetchPage({ ...rest, since, before: pageParam ?? undefined });
    },
  };
}

/** The Type filter's choices: each group's "every type" line, then its types, in catalogue order. */
export function auditTypeItems(): {
  group: string;
  items: { value: string; label: string }[];
}[] {
  return auditTypeGroups().map((group) => ({
    group: group.label,
    items: [
      { value: group.pattern, label: `All ${group.label.toLowerCase()}` },
      ...group.types.map((info) => ({
        value: info.type,
        label: info.description,
      })),
    ],
  }));
}
