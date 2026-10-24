// @vitest-environment happy-dom
/**
 * `useDataTable` with `query.data ?? []`: a new empty array on every render
 * while the query loads, or forever once it fails. TanStack Table resets the
 * page index whenever `data` changes, and that reset renders again, so
 * without the shared empty array the table re-renders without end.
 */
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ColumnDef } from "@tanstack/react-table";
import { afterEach, expect, it } from "vitest";
import { DataTable, useDataTable } from "./DataTable";

type Row = { id: string };

const columns: ColumnDef<Row>[] = [
  { id: "id", accessorKey: "id", header: "Id" },
];

let renders = 0;

function LoadingTable({ data }: { data?: Row[] }) {
  renders++;
  // A second render, as a query's status change would cause. The first one
  // only arms TanStack Table's page index reset.
  const [rerendered, setRerendered] = useState(false);
  useEffect(() => {
    if (!rerendered) setTimeout(() => setRerendered(true), 0);
  }, [rerendered]);

  const table = useDataTable({ data: data ?? [], columns, withSorting: true });
  return <DataTable table={table} isLoading empty={{ title: "No rows" }} />;
}

const previousActEnvironment = (
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT;

afterEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it("settles when the rows are a new empty array on every render", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  renders = 0;
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => root.render(<LoadingTable />));
  for (let tick = 0; tick < 10; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }

  expect(renders).toBeLessThan(5);
  act(() => root.unmount());
});

// With no rows the empty state stands in for the table: no header row
// describing nothing, and a way to clear the filters that emptied it.
function EmptyTable({
  isFiltered,
  onClearFilters,
}: {
  isFiltered?: boolean;
  onClearFilters?: () => void;
}) {
  const table = useDataTable({ data: [] as Row[], columns, withSorting: true });
  return (
    <DataTable
      table={table}
      empty={{ title: "No things yet" }}
      isFiltered={isFiltered}
      onClearFilters={onClearFilters}
    />
  );
}

it("stands in for the table when there are no rows", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<EmptyTable />));
  expect(container.querySelector("table")).toBeNull();
  expect(container.textContent).toContain("No things yet");
  act(() => root.unmount());
});

it("offers to clear the filters that emptied it", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  let cleared = 0;
  await act(async () =>
    root.render(<EmptyTable isFiltered onClearFilters={() => cleared++} />),
  );
  expect(container.querySelector("table")).toBeNull();
  expect(container.textContent).toContain("Nothing matches these filters");
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Clear filters");
  await act(async () => button?.click());
  expect(cleared).toBe(1);
  act(() => root.unmount());
});
