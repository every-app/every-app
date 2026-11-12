import { useMemo, useState } from "react";

/** A table's search box, for `DataTable`'s `search`. */
export interface TableSearch {
  /** The box's accessible name and placeholder: "Search users". */
  label: string;
  /** The empty state's title while the search hides every row: "No users match". */
  noMatch: string;
  value: string;
  onChange: (value: string) => void;
}

/** The text a row is searched by: its name, email, provider and the like. */
type SearchText<TData> = (row: TData) => readonly (string | null | undefined)[];

/**
 * A search box for a table of `noun` ("users"), and the rows whose text
 * contains what is typed, in any case. Pass `rows` to `useDataTable` and
 * `search` to `DataTable`.
 *
 * `rows` and `text` must keep their identity between renders, like
 * `useDataTable`'s `data`: memoize the rows (`query.data ?? []` is fine, as
 * `useDataTable` shares one empty array), and define `text` at module level.
 */
export function useTableSearch<TData>(
  rows: TData[],
  text: SearchText<TData>,
  noun: string,
): { rows: TData[]; search: TableSearch } {
  const [value, setValue] = useState("");
  const needle = value.trim().toLowerCase();
  const matching = useMemo(
    () =>
      needle
        ? rows.filter((row) =>
            text(row).some((field) => field?.toLowerCase().includes(needle)),
          )
        : rows,
    [rows, text, needle],
  );
  return {
    rows: matching,
    search: {
      label: `Search ${noun}`,
      noMatch: `No ${noun} match`,
      value,
      onChange: setValue,
    },
  };
}
