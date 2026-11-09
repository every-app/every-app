import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SearchScreen } from "@every-app/desktop-ui";
import { tabFor } from "../search";
import { useMeetingSearch, useSettled } from "../useSearch";

/** The full search page ("Show all results" from the ⌘K palette), with paging. */
export function SearchPage({ q }: { q: string }) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const settled = useSettled(text);
  const { results, query } = useMeetingSearch(settled);

  // Keep the query in the URL, so Back returns to these results.
  useEffect(() => {
    if (settled !== q.trim()) void navigate({ to: "/search", search: settled ? { q: settled } : {}, replace: true });
  }, [settled]); // only when what was typed settles; a new q from outside is taken below
  useEffect(() => {
    if (q.trim() !== settled) setText(q);
  }, [q]); // back/forward, or "Show all results" for another query

  return (
    <SearchScreen
      query={text}
      onQueryChange={setText}
      results={results}
      onOpen={(result) => {
        const tab = tabFor(result.field);
        void navigate({ to: "/meetings/$id", params: { id: result.meeting.id }, search: tab ? { tab } : {} });
      }}
      onLoadMore={() => void query.fetchNextPage()}
      loadingMore={query.isFetchingNextPage}
      onRetry={() => void query.refetch()}
    />
  );
}
