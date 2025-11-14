import { QueryClient } from "@tanstack/query-core";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24 * 7, // 7 days - extended to support persistence
      staleTime: 0, // Always refetch on mount to get latest data
    },
  },
});
