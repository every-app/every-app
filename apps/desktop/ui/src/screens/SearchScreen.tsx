import { cn } from "cn";
import { Search, WifiOff, X } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { Button } from "../components/ui/button";
import { dayLabel, timeOfDay } from "../lib/dates";
import { snippetParts } from "../lib/highlight";
import type { Loadable, SearchField, SearchResult } from "../types";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  ScreenBody,
  ownerLabel,
} from "./parts";

export type SearchResults =
  | { status: "idle" }
  /** Search runs on the server: offline, or signed out, there's nothing to search with. */
  | { status: "offline"; message?: string }
  | Loadable<{ results: SearchResult[]; hasMore: boolean }>;

export const OFFLINE_SEARCH =
  "Search needs a connection. Your meetings come back when you're online.";

export interface SearchScreenProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResults;
  onOpen: (result: SearchResult) => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  onRetry?: () => void;
  now?: Date;
}

/** The badge for where a result matched; a title match is shown by highlighting the title. */
export const fieldLabel: Record<Exclude<SearchField, "title">, string> = {
  notes: "Notes",
  jottings: "Jottings",
  transcript: "Transcript",
};

/** A snippet as text, with the matched words marked. Never parsed as markup. */
export function Highlighted({
  text,
  ranges,
  className,
}: {
  text: string;
  ranges: SearchResult["snippet"]["ranges"];
  className?: string;
}) {
  return (
    <span className={className}>
      {snippetParts(text, ranges).map((part, i) =>
        part.match ? (
          <mark
            key={i}
            className="rounded-[3px] bg-warning/35 px-px text-foreground dark:bg-warning/30"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

/** Up and down move between the box and the results; Enter opens one. */
function moveFocus(
  event: KeyboardEvent<HTMLElement>,
  list: HTMLElement | null,
) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = Array.from(
    list?.querySelectorAll<HTMLButtonElement>("[data-search-result]") ?? [],
  );
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(event.currentTarget as HTMLButtonElement);
  if (event.key === "ArrowDown")
    items[Math.min(items.length - 1, at + 1)]?.focus();
  else if (at <= 0)
    list?.parentElement
      ?.querySelector<HTMLInputElement>("[data-slot='search-input']")
      ?.focus();
  else items[at - 1]?.focus();
}

export function SearchScreen(props: SearchScreenProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const { query, results } = props;
  return (
    <ScreenBody className="gap-6">
      <div className="sticky top-0 z-10 -mx-2 bg-background/95 px-2 pb-2 pt-4 backdrop-blur">
        <label className="flex h-11 items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 shadow-xs focus-within:border-ring/50 focus-within:ring-3 focus-within:ring-ring/15">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            data-slot="search-input"
            type="search"
            aria-label="Search meetings"
            placeholder="Search titles, notes, transcripts and your jottings"
            autoFocus
            value={query}
            maxLength={200}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                props.onQueryChange("");
              } else moveFocus(event, listRef.current);
            }}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => props.onQueryChange("")}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>

      {results.status === "idle" ? (
        <EmptyState icon={Search} title="Search your meetings">
          Every word has to match, from the start of a word. Titles, notes,
          transcripts and your own jottings are searched.
        </EmptyState>
      ) : results.status === "offline" ? (
        <EmptyState icon={WifiOff} title="You're offline">
          {results.message ?? OFFLINE_SEARCH}
        </EmptyState>
      ) : results.status === "loading" ? (
        <LoadingRows rows={5} />
      ) : results.status === "error" ? (
        <ErrorState message={results.message} onRetry={props.onRetry} />
      ) : results.data.results.length === 0 ? (
        <EmptyState icon={Search} title={`No meetings match “${query.trim()}”`}>
          Try fewer words, or the start of a word.
        </EmptyState>
      ) : (
        <div className="-mx-3 flex flex-col gap-3">
          <ul
            ref={listRef}
            aria-label="Search results"
            className="flex flex-col"
          >
            {results.data.results.map((result) => (
              <li key={result.meeting.id}>
                <ResultRow
                  result={result}
                  now={props.now}
                  onOpen={() => props.onOpen(result)}
                  onKeyDown={(event) => moveFocus(event, listRef.current)}
                />
              </li>
            ))}
          </ul>
          {results.data.hasMore && props.onLoadMore && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={props.onLoadMore}
                pending={props.loadingMore}
              >
                More results
              </Button>
            </div>
          )}
        </div>
      )}
    </ScreenBody>
  );
}

function ResultRow({
  result,
  now,
  onOpen,
  onKeyDown,
}: {
  result: SearchResult;
  now?: Date;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      data-search-result
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className="group flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.05] focus-visible:outline-none"
    >
      <ResultContent result={result} now={now} />
    </button>
  );
}

/** A result's title, date, matched-field badge and highlighted snippet (shared with the palette). */
export function ResultContent({
  result,
  now,
  compact = false,
}: {
  result: SearchResult;
  now?: Date;
  compact?: boolean;
}) {
  const { meeting, field, snippet } = result;
  const when = new Date(meeting.startsAt);
  return (
    <>
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
          {field === "title" ? (
            <Highlighted text={snippet.text} ranges={snippet.ranges} />
          ) : (
            meeting.title
          )}
        </span>
        {field !== "title" && (
          <span
            className={cn(
              "shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground",
              field === "jottings" && "border-me/60",
            )}
          >
            {fieldLabel[field]}
          </span>
        )}
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
          {dayLabel(when, now)}
          {!compact && <>, {timeOfDay(meeting.startsAt)}</>}
        </span>
      </span>
      {field !== "title" && (
        <Highlighted
          text={snippet.text}
          ranges={snippet.ranges}
          className={cn(
            "text-[13px] leading-relaxed text-foreground/70",
            compact ? "line-clamp-1" : "line-clamp-2",
          )}
        />
      )}
      {!meeting.mine && (
        <span className="text-[11px] text-muted-foreground">
          {ownerLabel(meeting)}
        </span>
      )}
    </>
  );
}
