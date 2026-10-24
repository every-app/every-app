import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Row,
  type Table as TanStackTable,
  type TableOptions,
} from "@tanstack/react-table";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { EmptyState } from "@/client/components/EmptyState";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";

type AppColumnMeta<TData> = {
  headerClassName?: string;
  cellClassName?: string | ((row: Row<TData>) => string | undefined);
};

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> extends AppColumnMeta<TData> {
    readonly __valueType?: TValue;
  }
}

type UseDataTableOptions<TData> = Omit<
  TableOptions<TData>,
  "getCoreRowModel"
> & {
  withSorting?: boolean;
  withExpanded?: boolean;
  withPagination?: boolean;
};

// One empty array for every table with no rows yet. See `useDataTable`.
const NO_ROWS: never[] = [];

/**
 * A TanStack table with the row models a page asks for.
 *
 * `data` and `columns` must keep their identity between renders. A new
 * `data` array resets the page index, and that reset renders again, so an
 * array rebuilt on every render (an unmemoized `.filter`) re-renders forever.
 * A new `columns` array remounts every cell, because each `cell` function
 * renders as a component, which closes an open row menu. Memoize both, or
 * define the columns at module level. An empty `data` is swapped for one
 * shared array, so `query.data ?? []` is safe while the query loads.
 */
export function useDataTable<TData>(options: UseDataTableOptions<TData>) {
  const { withSorting, withExpanded, withPagination, data, ...tableOptions } =
    options;
  return useReactTable({
    ...tableOptions,
    data: data.length === 0 ? NO_ROWS : data,
    getCoreRowModel: getCoreRowModel(),
    ...(withSorting ? { getSortedRowModel: getSortedRowModel() } : {}),
    ...(withExpanded ? { getExpandedRowModel: getExpandedRowModel() } : {}),
    ...(withPagination
      ? { getPaginationRowModel: getPaginationRowModel() }
      : {}),
  });
}

/** The frame around the rows, for table components that pass it through. */
type DataTableFrameProps = {
  /** The first load: shows skeleton rows under the real headers. */
  isLoading?: boolean;
  /** True when filters are active. An empty table then offers `onClearFilters`. */
  isFiltered?: boolean;
  onClearFilters?: () => void;
  /**
   * A load failure, for example a `QueryError`. It shows above the rows. With
   * no rows it replaces the table, so a failed load never reads as empty.
   */
  error?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
};

/**
 * The table body of a data table: sortable headers, skeleton rows while the
 * first page loads, and an empty state that says whether filters hide rows.
 *
 * The table component owns sorting and filters, and passes them to
 * `useDataTable`. Put a `DataTableToolbar` in `toolbar`.
 */
export function DataTable<TData>({
  table,
  isLoading = false,
  empty,
  isFiltered = false,
  onClearFilters,
  error,
  toolbar,
  footer,
  onRowClick,
  activeRowId,
  scrollClassName,
}: DataTableFrameProps & {
  table: TanStackTable<TData>;
  /** Shown when there are no rows and no filters. */
  empty: Pick<
    ComponentProps<typeof EmptyState>,
    "kind" | "icon" | "title" | "description" | "action"
  >;
  /** Makes each row clickable, for example to open its details beside the table. */
  onRowClick?: (
    row: Row<TData>,
    event: MouseEvent<HTMLTableRowElement>,
  ) => void;
  /** Highlights the row whose details are open. */
  activeRowId?: string;
  /** Caps the table height, for example `max-h-96`. The header stays in view while the rows scroll. */
  scrollClassName?: string;
}) {
  const columns = table.getVisibleLeafColumns();
  const rows = table.getRowModel().rows;

  // A load that failed before any row arrived: the failure stands alone.
  if (error && !isLoading && rows.length === 0) {
    return <>{error}</>;
  }

  return (
    <TableCard>
      {toolbar}
      {error ? <div className="p-4">{error}</div> : null}
      {
        <Table containerClassName={scrollClassName}>
          <TableHeader
            className={
              scrollClassName ? "sticky top-0 z-10 bg-card" : undefined
            }
          >
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={header.column.columnDef.meta?.headerClassName}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }, (_, index) => (
                <TableRow key={index} aria-hidden>
                  {columns.map((column) => (
                    <TableCell key={column.id}>
                      <Skeleton
                        className={
                          column.id === "select" ? "size-4" : "h-4 w-full"
                        }
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length}>
                  {isFiltered ? (
                    <EmptyState
                      kind="filtered"
                      variant="plain"
                      title="No rows match these filters"
                      description="Change or clear the filters to see more rows."
                      action={
                        onClearFilters ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={onClearFilters}
                          >
                            Clear filters
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <EmptyState variant="plain" {...empty} />
                  )}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  data-active={row.id === activeRowId ? "" : undefined}
                  className={
                    onRowClick
                      ? "cursor-pointer data-active:bg-primary/5 data-active:shadow-[inset_2px_0_0_var(--color-primary)]"
                      : undefined
                  }
                  onClick={
                    onRowClick ? (event) => onRowClick(row, event) : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta?.cellClassName;
                    return (
                      <TableCell
                        key={cell.id}
                        className={
                          typeof meta === "function" ? meta(row) : meta
                        }
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      }
      {footer}
    </TableCard>
  );
}
