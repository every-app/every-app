import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/src/lib/auth-client";
import type { GatewaySession } from "@/src/types/gateway";

export function useSessionQuery() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["auth", "session"],
    queryFn: async (): Promise<GatewaySession | null> => {
      const { data, error } = await authClient.getSession();
      if (error) {
        throw new Error(error.message ?? "Failed to fetch session");
      }
      return (data as GatewaySession | null) ?? null;
    },
    retry: 1,
  });

  const invalidateSession = async () => {
    await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
  };

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    invalidateSession,
  };
}
