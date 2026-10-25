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

// Under `md` the rows render as cards beside the table (CSS shows one): the
// first cell as the heading, the actions menu top right, the other cells as
// label and value. Columns with a component header (every `SortableHeader`
// column in the admin tables) say their label in `meta.label`; a string
// header is its own label. `role` covers the first path, `team` the second.
type Person = {
  id: string;
  name: string;
  role: string;
  team: string;
  secret: string;
};

const cardColumns: ColumnDef<Person>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: () => <span>Name</span>,
    meta: { label: "Name" },
  },
  {
    id: "role",
    accessorKey: "role",
    header: () => <span>Role</span>,
    meta: { label: "Role" },
  },
  { id: "team", accessorKey: "team", header: "Team" },
  {
    id: "secret",
    accessorKey: "secret",
    header: "Secret",
    meta: { hideOnCard: true },
  },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => (
      <button type="button" aria-label={`Actions for ${row.original.name}`}>
        …
      </button>
    ),
  },
];

const people: Person[] = [
  { id: "1", name: "Ada", role: "Owner", team: "Analysis", secret: "hush-1" },
  {
    id: "2",
    name: "Grace",
    role: "Member",
    team: "Compilers",
    secret: "hush-2",
  },
];

function CardTable({ isLoading = false }: { isLoading?: boolean }) {
  const table = useDataTable({
    data: people,
    columns: cardColumns,
    getRowId: (person) => person.id,
  });
  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      empty={{ title: "Nobody" }}
    />
  );
}

function cardsOf(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="data-table-card"]'),
  );
}

it("renders each row as a card with the first cell as its heading", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<CardTable />));

  // The table is still there for `md` and up.
  expect(container.querySelectorAll("table tbody tr")).toHaveLength(2);

  const cards = cardsOf(container);
  expect(cards).toHaveLength(2);
  expect(
    cards[0]?.querySelector('[data-slot="data-table-card-primary"]')
      ?.textContent,
  ).toBe("Ada");
  // The heading carries no label (its `meta.label` is unused); the other
  // cells do: Role from `meta.label` beside a component header, Team from
  // its string header.
  const labels = (card: HTMLElement) =>
    Array.from(card.querySelectorAll("dt")).map((dt) => dt.textContent);
  expect(labels(cards[0]!)).toEqual(["Role", "Team"]);
  const values = (card: HTMLElement) =>
    Array.from(card.querySelectorAll("dd")).map((dd) => dd.textContent);
  expect(values(cards[0]!)).toEqual(["Owner", "Analysis"]);
  act(() => root.unmount());
});

it("puts the actions cell on each card once, without a label", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<CardTable />));
  for (const card of cardsOf(container)) {
    expect(
      card.querySelectorAll('button[aria-label^="Actions for"]'),
    ).toHaveLength(1);
    expect(
      card.querySelector('[data-slot="data-table-card-actions"] button'),
    ).not.toBeNull();
    // The sr-only header is not a label.
    expect(card.textContent).not.toContain("Actions");
  }
  act(() => root.unmount());
});

it("leaves hideOnCard columns off the cards", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<CardTable />));
  const cards = container.querySelector('[data-slot="data-table-cards"]');
  expect(cards?.textContent).not.toContain("hush");
  expect(cards?.textContent).not.toContain("Secret");
  // The table keeps the column.
  expect(container.querySelector("table")?.textContent).toContain("hush-1");
  act(() => root.unmount());
});

it("shows skeleton cards while the first page loads", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<CardTable isLoading />));
  expect(cardsOf(container)).toHaveLength(0);
  expect(
    container.querySelectorAll(
      '[data-slot="data-table-cards"] [aria-hidden="true"]',
    ).length,
  ).toBeGreaterThan(0);
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
