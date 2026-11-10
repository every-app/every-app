import { useQuery } from "@tanstack/react-query";
import { listMyConnections } from "@/serverFunctions/connections";

export const CONNECTED_ACCOUNTS_KEY = ["connections", "accounts"] as const;

/**
 * The signed-in person's connected accounts. Connections reads them twice,
 * for the Accounts tab's table and for the count on that tab, so both are
 * this one query and a disconnect updates both.
 */
export function useConnectedAccounts() {
  return useQuery({
    queryKey: CONNECTED_ACCOUNTS_KEY,
    queryFn: () => listMyConnections(),
  });
}
