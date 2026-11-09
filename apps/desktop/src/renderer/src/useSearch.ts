// The search behind both the ⌘K palette and the search page: waits for typing to pause, asks
// /api/v1/search, and says when it can't (offline, or the sign-in ran out).

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SearchResults } from "@every-app/desktop-ui";
import { api, cleanError, keys } from "./api";
import { connectionOf } from "./connection";
import { searchable, searchState } from "./search";
import { useAppState } from "./bridge";

export const TYPING_PAUSE_MS = 200;

export function useSettled(text: string, delay = TYPING_PAUSE_MS): string {
  const [settled, setSettled] = useState(text.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text.trim()), delay);
    return () => clearTimeout(timer);
  }, [text, delay]);
  return settled;
}

export function useMeetingSearch(settled: string, limit = 20) {
  const connection = connectionOf(useAppState());
  const enabled = searchable(settled) && connection === "online";
  const query = useInfiniteQuery({
    queryKey: [...keys.search(settled), limit],
    queryFn: ({ pageParam }) => api.search(settled, pageParam, limit),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    // While a new query loads, keep the last results on screen instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });
  const results: SearchResults = searchState({
    settled,
    connection,
    pending: query.isPending,
    error: query.isError ? cleanError(query.error) : null,
    results: query.data?.pages.flatMap((p) => p.results) ?? [],
    hasMore: !!query.hasNextPage,
  });
  return { results, query };
}
