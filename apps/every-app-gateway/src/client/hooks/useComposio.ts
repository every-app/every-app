import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getRuleErrorMessage } from "@/client/errors";
import {
  getComposioStatus,
  getComposioSwitch,
  setComposioSwitch,
} from "@/serverFunctions/composio";

const COMPOSIO_SWITCH_KEY = ["admin", "composio"] as const;
export const COMPOSIO_STATUS_KEY = ["connections", "composio"] as const;

/**
 * The organization's Composio switch, with how many links and connections
 * turning it off would delete (docs/design/2026-11-composio.md). The
 * server answers owners and admins only, so only what they see reads it.
 */
export function useComposioSwitch() {
  return useQuery({
    queryKey: COMPOSIO_SWITCH_KEY,
    queryFn: () => getComposioSwitch(),
  });
}

/** Whether Composio is on for the organization, and the signed-in person's own link to it. */
export function useComposioStatus() {
  return useQuery({
    queryKey: COMPOSIO_STATUS_KEY,
    queryFn: () => getComposioStatus(),
  });
}

/**
 * Turn Composio on or off for the organization. The switch decides which
 * providers are set up, which apps open and which connections exist, so
 * every list on screen is read again. Nothing waits for that: a dialog
 * that offered the switch may be gone once the lists say it is on.
 * Off without `confirm` may answer `needsConfirm` instead: nothing
 * changed, and the caller asks first.
 */
export function useSetComposio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { on: boolean; confirm?: boolean }) =>
      setComposioSwitch({ data }),
    onSuccess: (result) => {
      if ("needsConfirm" in result) return;
      void queryClient.invalidateQueries();
      toast.success(
        result.composio === "on" ? "Composio turned on" : "Composio turned off",
      );
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to change Composio")),
  });
}
