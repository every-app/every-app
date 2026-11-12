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
  createContext,
  Fragment,
  useContext,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "cn";
import { EmptyState } from "@/client/components/EmptyState";
import { DataTablePagination } from "@/client/components/table/DataTablePagination";
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

/**
 * Where a column's cell sits on a row's card under `md`. The first column is
 * the card's heading and the `actions` column its menu; every other column
 * names its place, `Detail` unless it says otherwise.
 */
export enum CardSlot {
  /** In the line under the heading, after its label. */
  Detail = "detail",
  /** In that line without a label, for a value that names itself ("3 apps", a status chip). */
  BareDetail = "bare-detail",
  /** Right of the heading, before the menu: the one value people scan a list for. */
  Trailing = "trailing",
  /** Under the detail line at full width, for a bar or a control that needs room. */
  Footer = "footer",
  /** Off the card. The table keeps it. */
  Hidden = "hidden",
}

type AppColumnMeta<TData> = {
  headerClassName?: string;
  /** The `<td>`'s class. A card (under `md`) lays its cells out itself and ignores it. */
  cellClassName?: string | ((row: Row<TData>) => string | undefined);
  /**
   * The cell's label on a card, for a column whose header is a component (a
   * `SortableHeader`). A string header is its own label.
   */
  label?: string;
  /** Where the cell sits on a card; `CardSlot.Detail` when unset. */
  card?: CardSlot;
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
 * A TanStack table with the row models a page asks for. `withPagination`
 * shows ten rows at a time (`initialState.pagination.pageSize` changes that),
 * and `DataTable` adds the row that turns the page.
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

/**
 * Room for a name and a line under it (52px): a row with one line is the same
 * height as one with two, so a table doesn't stagger. A `SettingsRow` matches.
 */
const ROW_HEIGHT = "h-13";

/** The highlight of a clickable row whose details are open. */
const CLICKABLE_ROW =
  "cursor-pointer data-active:bg-primary/5 data-active:shadow-[inset_2px_0_0_var(--color-primary)]";

/** The label a card gives a cell: a string header, else `meta.label`. */
function cardLabel<TData>(column: Column<TData, unknown>): string | undefined {
  const { header, meta } = column.columnDef;
  return typeof header === "string" ? header : meta?.label;
}

function cardSlot<TData>(cell: Cell<TData, unknown>): CardSlot {
  return cell.column.columnDef.meta?.card ?? CardSlot.Detail;
}

function renderCell<TData>(cell: Cell<TData, unknown>) {
  return flexRender(cell.column.columnDef.cell, cell.getContext());
}

const InCardContext = createContext(false);

/**
 * True for a cell rendered on a card, where it can leave out what only the
 * table needs, such as the usual state a table column spells out ("Active").
 */
export function useInDataTableCard(): boolean {
  return useContext(InCardContext);
}

/**
 * One row as a list row: the first cell as its heading, a line of details
 * under it, the trailing value and the actions menu on the right. Each
 * column's `meta.card` says where its cell goes. There is no header row, so
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
  const [primary, ...rest] = row.getVisibleCells();
  if (!primary) return null;
  const actions = rest.find((cell) => cell.column.id === ACTIONS_COLUMN);
  const placed = rest.filter((cell) => cell !== actions);
  const inSlot = (...slots: CardSlot[]) =>
    placed.filter((cell) => slots.includes(cardSlot(cell)));
  const details = inSlot(CardSlot.Detail, CardSlot.BareDetail);
  const trailing = inSlot(CardSlot.Trailing);
  const footers = inSlot(CardSlot.Footer);

  return (
    <div
      data-slot="data-table-card"
      data-active={active ? "" : undefined}
      className={cn("px-4 py-3", onClick ? CLICKABLE_ROW : undefined)}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        {/* At least as tall as the trailing values, so a heading alone centers on them. */}
        <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center">
          <div data-slot="data-table-card-primary">{renderCell(primary)}</div>
          {details.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              {details.map((cell) => {
                const label =
                  cardSlot(cell) === CardSlot.Detail
                    ? cardLabel(cell.column)
                    : undefined;
                // A bare value is the item itself, so a cell that renders
                // nothing on a card leaves no gap, and a cell of two lines
                // keeps them stacked; a label sits on its value's line.
                return (
                  <span
                    key={cell.id}
                    data-slot="data-table-card-detail"
                    className={cn(
                      "mt-1 max-w-full min-w-0 empty:hidden",
                      label ? "inline-flex items-center gap-1" : undefined,
                    )}
                  >
                    {label ? (
                      <>
                        <span data-slot="data-table-card-label">{label}</span>
                        <span
                          data-slot="data-table-card-value"
                          className="min-w-0 text-foreground"
                        >
                          {renderCell(cell)}
                        </span>
                      </>
                    ) : (
                      renderCell(cell)
                    )}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
        {trailing.length > 0 ? (
          // As tall as a heading and the line under it, so a one-word value
          // centers on them however many detail lines follow.
          <div
            data-slot="data-table-card-trailing"
            className="flex min-h-9 shrink-0 items-center gap-2 text-sm text-muted-foreground"
          >
            {trailing.map((cell) => (
              <Fragment key={cell.id}>{renderCell(cell)}</Fragment>
            ))}
          </div>
        ) : null}
        {actions ? (
          // The menu's width even when a row has none (the owner's row), so
          // the trailing values line up down the list.
          <div
            data-slot="data-table-card-actions"
            className="-mr-2 flex min-h-9 min-w-7 shrink-0 items-center"
          >
            {renderCell(actions)}
          </div>
        ) : null}
      </div>
      {/* Under the whole row, the trailing value's width included. A cell that renders nothing leaves no gap. */}
      {footers.map((cell) => (
        <div
          key={cell.id}
          data-slot="data-table-card-footer"
          className="mt-2 empty:hidden"
        >
          {renderCell(cell)}
        </div>
      ))}
    </div>
  );
}

/**
 * The table body of a data table: sortable headers, skeleton rows while the
 * first page loads, and an empty state that says whether filters hide rows.
 * Under `md` the rows are list rows instead (`DataTableCard`), so a phone
 * never scrolls a table sideways; the two layouts render together and CSS
 * shows one.
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
                <TableRow key={index} aria-hidden className={ROW_HEIGHT}>
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
                  className={cn(
                    ROW_HEIGHT,
                    onRowClick ? CLICKABLE_ROW : undefined,
                  )}
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
          "divide-y divide-border text-sm md:hidden",
          scrollClassName ? cn("overflow-y-auto", scrollClassName) : undefined,
        )}
      >
        <InCardContext.Provider value>
          {isLoading
            ? Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <div key={index} aria-hidden className="space-y-2 px-4 py-3">
                  <Skeleton className="h-4 w-1/2" />
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
        </InCardContext.Provider>
      </div>
      {table.options.getPaginationRowModel ? (
        <DataTablePagination table={table} />
      ) : null}
      {footer}
    </TableCard>
  );
}
