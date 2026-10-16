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
