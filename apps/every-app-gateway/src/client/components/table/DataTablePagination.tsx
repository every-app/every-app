import type { Table } from "@tanstack/react-table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/client/components/ui/pagination";

/**
 * The last row of a paged `DataTable`: which rows of how many are showing,
 * and the buttons that turn the page. Nothing while every row fits on one
 * page. `DataTable` adds it to a table made with `withPagination`.
 */
export function DataTablePagination<TData>({ table }: { table: Table<TData> }) {
  if (table.getPageCount() <= 1) return null;
  const { pageIndex, pageSize } = table.getState().pagination;
  const total = table.getPrePaginationRowModel().rows.length;
  const first = pageIndex * pageSize + 1;
  const last = Math.min(first + pageSize - 1, total);
  return (
    <div
      data-slot="data-table-pagination"
      className="flex items-center justify-between gap-3 border-t border-border px-4 py-2"
    >
      <p className="text-sm text-muted-foreground tabular-nums">
        {first}–{last} of {total}
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
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
