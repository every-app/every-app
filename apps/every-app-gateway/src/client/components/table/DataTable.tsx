import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Cell,
  type Column,
  type Row,
  type Table as TanStackTable,
  type TableOptions,
} from "@tanstack/react-table";
import {
  Fragment,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "cn";
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
  /** The `<td>`'s class. A card (under `md`) lays its cells out itself and ignores it. */
  cellClassName?: string | ((row: Row<TData>) => string | undefined);
  /**
   * The cell's label on a card, for a column whose header is a component (a
   * `SortableHeader`). A string header is its own label.
   */
  label?: string;
  /** Leaves the column off the cards. The table keeps it. */
  hideOnCard?: boolean;
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
  /** The title of the empty state while filters hide every row. */
  filteredTitle?: string;
  /**
   * A load failure, for example a `QueryError`. It shows above the rows. With
   * no rows it replaces the table, so a failed load never reads as empty.
   */
  error?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
};

/** The column whose cell is the row's kebab menu: a card puts it top right. */
const ACTIONS_COLUMN = "actions";

/** Skeleton rows (or cards) while the first page loads. */
const SKELETON_ROWS = 8;

/** The highlight of a clickable row whose details are open. */
const CLICKABLE_ROW =
  "cursor-pointer data-active:bg-primary/5 data-active:shadow-[inset_2px_0_0_var(--color-primary)]";

/** The label a card gives a cell: a string header, else `meta.label`. */
function cardLabel<TData>(column: Column<TData, unknown>): string | undefined {
  const { header, meta } = column.columnDef;
  return typeof header === "string" ? header : meta?.label;
}

function renderCell<TData>(cell: Cell<TData, unknown>) {
  return flexRender(cell.column.columnDef.cell, cell.getContext());
}

/**
 * One row as a card: the first cell as its heading, the actions menu top
 * right, every other cell a label and a value. There is no header row, so
 * the cards cannot be sorted; the table's default order stands.
 */
function DataTableCard<TData>({
  row,
  active,
  onClick,
}: {
  row: Row<TData>;
  active: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const cells = row
    .getVisibleCells()
    .filter((cell) => !cell.column.columnDef.meta?.hideOnCard);
  const primary = cells[0];
  if (!primary) return null;
  const actions = cells.find(
    (cell) => cell !== primary && cell.column.id === ACTIONS_COLUMN,
  );
  const details = cells.filter((cell) => cell !== primary && cell !== actions);

  return (
    <div
      data-slot="data-table-card"
      data-active={active ? "" : undefined}
      className={cn("space-y-2 px-4 py-3", onClick ? CLICKABLE_ROW : undefined)}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div data-slot="data-table-card-primary" className="min-w-0 flex-1">
          {renderCell(primary)}
        </div>
        {actions ? (
          <div
            data-slot="data-table-card-actions"
            className="-my-1 -mr-2 shrink-0"
          >
            {renderCell(actions)}
          </div>
        ) : null}
      </div>
      {details.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          {details.map((cell) => {
            const label = cardLabel(cell.column);
            return (
              <Fragment key={cell.id}>
                {label ? (
                  <dt className="text-xs leading-5 text-muted-foreground">
                    {label}
                  </dt>
                ) : null}
                <dd
                  className={cn(
                    "flex min-w-0 flex-col items-end text-right",
                    label ? undefined : "col-span-full",
                  )}
                >
                  {renderCell(cell)}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * The table body of a data table: sortable headers, skeleton rows while the
 * first page loads, and an empty state that says whether filters hide rows.
 * Under `md` the rows are cards instead (`DataTableCard`), so a phone never
 * scrolls a table sideways; the two layouts render together and CSS shows
 * one.
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
  filteredTitle = "Nothing matches these filters",
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
  onRowClick?: (row: Row<TData>, event: MouseEvent<HTMLElement>) => void;
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

  // No rows: the empty state stands in for the table, with no header row
  // describing nothing. A toolbar keeps its card, so the filters that
  // emptied the table stay where they are.
  if (!isLoading && rows.length === 0) {
    const emptyState = isFiltered ? (
      <EmptyState
        kind="filtered"
        variant={toolbar ? "plain" : "dashed"}
        title={filteredTitle}
        action={
          onClearFilters ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState variant={toolbar ? "plain" : "dashed"} {...empty} />
    );
    return toolbar ? (
      <TableCard>
        {toolbar}
        {emptyState}
        {footer}
      </TableCard>
    ) : (
      <>
        {emptyState}
        {footer}
      </>
    );
  }

  return (
    <TableCard>
      {toolbar}
      {error ? <div className="p-4">{error}</div> : null}
      <Table containerClassName={cn("hidden md:block", scrollClassName)}>
        <TableHeader
          className={scrollClassName ? "sticky top-0 z-10 bg-card" : undefined}
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
          {isLoading
            ? Array.from({ length: SKELETON_ROWS }, (_, index) => (
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
            : rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  data-active={row.id === activeRowId ? "" : undefined}
                  className={onRowClick ? CLICKABLE_ROW : undefined}
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
                        {renderCell(cell)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
        </TableBody>
      </Table>
      <div
        data-slot="data-table-cards"
        className={cn(
          // Cells are written for a table row, where a long value truncates
          // so the columns beside it keep their place. A card has nothing
          // beside the value, so it wraps instead.
          "divide-y divide-border text-sm md:hidden [&_.truncate]:whitespace-normal [&_.truncate]:wrap-anywhere",
          scrollClassName ? cn("overflow-y-auto", scrollClassName) : undefined,
        )}
      >
        {isLoading
          ? Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <div key={index} aria-hidden className="space-y-2 px-4 py-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))
          : rows.map((row) => (
              <DataTableCard
                key={row.id}
                row={row}
                active={row.id === activeRowId}
                onClick={
                  onRowClick ? (event) => onRowClick(row, event) : undefined
                }
              />
            ))}
      </div>
      {footer}
    </TableCard>
  );
}
