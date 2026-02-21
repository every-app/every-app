import { useQuery } from "@tanstack/react-query";
import { fetchUserApps } from "@/src/api/gateway";

export function useUserAppsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["apps", "user"],
    queryFn: fetchUserApps,
    enabled,
    retry: 1,
  });
}
