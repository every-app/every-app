import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/client/auth-client";
import type { Auth } from "@/auth";

interface SessionData {
  user: Auth["$Infer"]["Session"]["user"];
  session: Auth["$Infer"]["Session"]["session"];
}

/**
 * React Query-based session hook that persists session data to localStorage.
 * This prevents unnecessary loading states on page load by using cached session data.
 */
export function useSession() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["auth", "session"],
    queryFn: async (): Promise<SessionData | null> => {
      if (!authClient) {
        return null;
      }
      const { data: session, error } = await authClient.getSession();

      if (error) {
        console.error("Failed to fetch session:", error);
        throw error;
      }

      return session as SessionData | null;
    },
    gcTime: 1000 * 60 * 60 * 24 * 7, // Keep in cache for 7 days (matches queryClient default)
    retry: 1, // Only retry once on failure
    refetchOnWindowFocus: true, // Refetch when user returns to the tab
    refetchOnMount: true, // Refetch on component mount, but will use cache if still fresh
  });

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
  };

  return {
    data: query.data ?? null,
    isPending: query.isPending,
    error: query.error,
    refetch,
  };
}
