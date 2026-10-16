import type { ReactNode } from "react";
import { Search } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/client/components/ui/input-group";

// The row above a `DataTable`'s headers, inside its card.

/** Filter controls on the left, actions or a count on the right. */
export function DataTableToolbar({
  children,
  actions,
}: {
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/** A search box for a toolbar. The table filters its rows on `value`. */
export function DataTableSearch({
  label,
  value,
  onChange,
}: {
  /** The accessible name, also the placeholder: "Search apps". */
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup className="h-8 w-full sm:w-64">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        aria-label={label}
        placeholder={`${label}…`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </InputGroup>
  );
}
