import { QueryClient } from "@tanstack/query-core";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24 * 7, // 7 days - keep data in cache for persistence
      staleTime: 0, // Always refetch on mount to get latest data
      refetchOnMount: "always", // Always refetch when query mounts/remounts
    },
  },
});
