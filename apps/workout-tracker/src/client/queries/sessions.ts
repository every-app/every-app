import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completeWorkoutSession,
  createSession,
  deleteSession,
  getAllSessions,
  skipToWorkout,
  updateSession,
} from "@/serverFunctions/sessions";
import type {
  CompleteSessionInput,
  CreateSessionInput,
  SkipToWorkoutInput,
  UpdateSessionInput,
} from "@/types/schemas/sessions";

const sessionsKey = ["sessions"] as const;

export function useSessions() {
  return useQuery({
    queryKey: sessionsKey,
    queryFn: async () => {
      const result = await getAllSessions();
      return result.sessions.map(
        ({ workoutSetLogs: _, ...session }) => session,
      );
    },
  });
}

export function useSessionMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: sessionsKey });

  return {
    create: useMutation({
      mutationFn: (data: CreateSessionInput) => createSession({ data }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (data: UpdateSessionInput) => updateSession({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: { id: string }) => deleteSession({ data }),
      onSuccess: () =>
        Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: ["setLogs"] }),
        ]),
    }),
    complete: useMutation({
      mutationFn: (data: CompleteSessionInput) =>
        completeWorkoutSession({ data }),
      onSuccess: () =>
        Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: ["programs"] }),
          queryClient.invalidateQueries({ queryKey: ["workoutExercises"] }),
        ]),
    }),
    skipToWorkout: useMutation({
      mutationFn: (data: SkipToWorkoutInput) => skipToWorkout({ data }),
      onSuccess: () =>
        Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: ["programs"] }),
        ]),
    }),
  };
}
