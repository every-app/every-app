import { useEffect, useState } from "react";
import type { Table } from "@tanstack/react-table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/client/components/ui/pagination";

/**
 * Rows a table hasn't loaded yet, for a log the server pages through. Make
 * the table with `useDataTable`'s `withLoadMore`, so it keeps its page as
 * the rows arrive.
 */
export interface LoadMore {
  hasMore: boolean;
  isLoading: boolean;
  /** Fetches the next rows; false when the fetch failed. */
  load: () => Promise<boolean>;
}

/**
 * The last row of a `DataTable`: which rows of how many are showing, and the
 * buttons that turn the page. Nothing while every row fits on one page.
 * With `loadMore`, Next on the last loaded page fetches more: a full page
 * turns to them once they arrive, and a short one fills in.
 */
export function DataTablePagination<TData>({
  table,
  loadMore,
}: {
  table: Table<TData>;
  loadMore?: LoadMore;
}) {
  const [advancing, setAdvancing] = useState(false);
  const canNext = table.getCanNextPage();
  const hasMore = loadMore?.hasMore ?? false;

  useEffect(() => {
    if (!advancing || !canNext) return;
    setAdvancing(false);
    table.nextPage();
  }, [advancing, canNext, table]);

  if (table.getPageCount() <= 1 && !hasMore) return null;
  const { pageIndex, pageSize } = table.getState().pagination;
  const total = table.getPrePaginationRowModel().rows.length;
  const first = pageIndex * pageSize + 1;
  const last = Math.min(first + pageSize - 1, total);

  const next = async () => {
    if (canNext) {
      table.nextPage();
      return;
    }
    setAdvancing(last - first + 1 === pageSize);
    if (!(await loadMore!.load())) setAdvancing(false);
  };

  return (
    <div
      data-slot="data-table-pagination"
      className="flex items-center justify-between gap-3 border-t border-border px-4 py-2"
    >
      <p className="text-sm text-muted-foreground tabular-nums">
        {first}–{last} of {total}
        {hasMore ? "+" : ""}
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              disabled={
                advancing || loadMore?.isLoading || (!canNext && !hasMore)
              }
              onClick={() => void next()}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
