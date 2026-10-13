import { useQuery } from "@tanstack/react-query";
import { getActiveOrganization } from "@/serverFunctions/organizations";

export const ACTIVE_ORGANIZATION_QUERY_KEY = ["active-organization"] as const;

/**
 * The organization the session acts under: id, name, slug and the caller's
 * role. Read from the gateway, not Better Auth's get-full-organization
 * (closed: it returned every pending invitation to any member).
 */
export function useActiveOrganization({ enabled = true } = {}) {
  return useQuery({
    queryKey: ACTIVE_ORGANIZATION_QUERY_KEY,
    queryFn: () => getActiveOrganization(),
    enabled,
  });
}
