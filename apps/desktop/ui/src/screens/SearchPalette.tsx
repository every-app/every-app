import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { ArrowRight, Loader2, Search, WifiOff } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { SearchResult } from "../types";
import {
  OFFLINE_SEARCH,
  ResultContent,
  type SearchResults,
} from "./SearchScreen";

export interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResults;
  /** Open a result's meeting (the palette closes). */
  onOpen: (result: SearchResult) => void;
  /** "Show all results": the full search page for this query. */
  onShowAll?: () => void;
  now?: Date;
}

/**
 * ⌘K: a quiet search over every meeting. Focus stays in the box; ↑/↓ moves through the results,
 * Enter opens one, Esc closes.
 */
export function SearchPalette(props: SearchPaletteProps) {
  const { results, query } = props;
  const listId = useId();
  const items = results.status === "ready" ? results.data.results : [];
  const showAll =
    results.status === "ready" && results.data.hasMore && !!props.onShowAll;
  const count = items.length + (showAll ? 1 : 0);
  const [active, setActive] = useState(0);
  // A new set of results starts at the top.
  const signature = `${results.status}:${items.map((r) => r.meeting.id).join(",")}`;
  useEffect(() => setActive(0), [signature]);

  const choose = (index: number) => {
    if (index < items.length) props.onOpen(items[index]!);
    else if (showAll) props.onShowAll?.();
  };

  return (
    <DialogPrimitive.Root
      open={props.open}
      onOpenChange={(open) => props.onOpenChange(open)}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/15 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 dark:bg-black/35" />
        <DialogPrimitive.Popup
          aria-label="Search meetings"
          className="fixed left-1/2 top-[14%] z-50 flex max-h-[min(560px,72%)] w-[min(620px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_24px_60px_-12px_rgb(0_0_0/0.35),0_0_0_0.5px_rgb(0_0_0/0.08)] outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0"
        >
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
            {results.status === "loading" ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Search className="size-4 shrink-0 text-muted-foreground" />
            )}
            <input
              data-slot="palette-input"
              role="combobox"
              aria-label="Search meetings"
              aria-expanded={count > 0}
              aria-controls={listId}
              aria-activedescendant={
                count > 0 ? `${listId}-${active}` : undefined
              }
              aria-autocomplete="list"
              autoFocus
              placeholder="Search meetings"
              value={query}
              maxLength={200}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && count > 0) {
                  event.preventDefault();
                  setActive((a) => (a + 1) % count);
                } else if (event.key === "ArrowUp" && count > 0) {
                  event.preventDefault();
                  setActive((a) => (a - 1 + count) % count);
                } else if (event.key === "Enter" && count > 0) {
                  event.preventDefault();
                  choose(active);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/70"
            />
            <kbd className="font-sans text-[11px] text-muted-foreground">
              esc
            </kbd>
          </div>

          <div className="min-h-0 overflow-y-auto">
            {results.status === "idle" ? (
              <Quiet>
                Type to search titles, notes, transcripts and your jottings.
              </Quiet>
            ) : results.status === "offline" ? (
              <Quiet icon={<WifiOff className="size-3.5" />}>
                {results.message ?? OFFLINE_SEARCH}
              </Quiet>
            ) : results.status === "error" ? (
              <Quiet tone="error">{results.message}</Quiet>
            ) : results.status === "loading" ? (
              <Quiet>Searching…</Quiet>
            ) : items.length === 0 ? (
              <Quiet>No meetings match “{query.trim()}”.</Quiet>
            ) : (
              <ul
                id={listId}
                role="listbox"
                aria-label="Results"
                className="flex flex-col p-1.5"
              >
                {items.map((result, i) => (
                  <li
                    key={result.meeting.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(i)}
                    className={cn(
                      "flex cursor-default flex-col gap-0.5 rounded-lg px-3 py-2",
                      i === active && "bg-foreground/[0.06]",
                    )}
                  >
                    <ResultContent result={result} now={props.now} compact />
                  </li>
                ))}
                {showAll && (
                  <li
                    id={`${listId}-${items.length}`}
                    role="option"
                    aria-selected={active === items.length}
                    onMouseMove={() => setActive(items.length)}
                    onClick={() => choose(items.length)}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-muted-foreground",
                      active === items.length &&
                        "bg-foreground/[0.06] text-foreground",
                    )}
                  >
                    <ArrowRight className="size-3.5" />
                    Show all results
                  </li>
                )}
              </ul>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Quiet({
  children,
  icon,
  tone,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "error";
}) {
  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-2 px-4 py-5 text-[13px] text-muted-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      {icon}
      {children}
    </p>
  );
}
