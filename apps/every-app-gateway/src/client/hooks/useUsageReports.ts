import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getRuleErrorMessage } from "@/client/errors";
import {
  getUsageReports,
  setUsageReportsSwitch,
} from "@/serverFunctions/telemetry";

const USAGE_REPORTS_KEY = ["admin", "usage-reports"] as const;

/**
 * Whether this Gateway sends Every App its daily usage report, with the
 * next report and the last one sent. The server answers owners and admins
 * only, so only what they see reads it.
 */
export function useUsageReports() {
  return useQuery({
    queryKey: USAGE_REPORTS_KEY,
    queryFn: () => getUsageReports(),
  });
}

/** Turn usage reports on or off. */
export function useSetUsageReports() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => setUsageReportsSwitch({ data: { on } }),
    onSuccess: (result) => {
      queryClient.setQueryData(USAGE_REPORTS_KEY, result);
      toast.success(
        result.usageReports === "on"
          ? "Usage reports turned on"
          : "Usage reports turned off. Nothing more is sent.",
      );
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to change usage reports")),
  });
}
