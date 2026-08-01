import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteSetLog,
  getAllSetLogs,
  upsertSetLog,
} from "@/serverFunctions/setLogs";
import type { UpsertSetLogInput } from "@/types/schemas/setLogs";

const setLogsKey = ["setLogs"] as const;

export function useSetLogs() {
  return useQuery({
    queryKey: setLogsKey,
    queryFn: async () => (await getAllSetLogs()).setLogs,
  });
}

export function useSetLogMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: setLogsKey });

  return {
    upsert: useMutation({
      mutationFn: (data: UpsertSetLogInput) => upsertSetLog({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: { id: string }) => deleteSetLog({ data }),
      onSuccess: invalidate,
    }),
  };
}
