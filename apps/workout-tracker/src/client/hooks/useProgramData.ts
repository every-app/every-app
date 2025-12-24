import { useLiveQuery } from "@tanstack/react-db";
import {
  programsCollection,
  workoutsCollection,
  exercisesCollection,
  exerciseLibraryCollection,
} from "@/client/tanstack-db";
import type {
  Program,
  Workout,
  WorkoutExercise,
  ExerciseLibraryItem,
} from "@/db/schema";

/**
 * A workout exercise with its library data (name) attached
 */
export type WorkoutExerciseWithName = WorkoutExercise & {
  name: string;
  notes: string | null;
};

/**
 * A workout with its nested exercises (with names), sorted by sortOrder
 */
export type WorkoutWithExercises = Workout & {
  exercises: WorkoutExerciseWithName[];
};

/**
 * A program with its nested workouts and exercises, sorted by sortOrder
 */
export type ProgramWithWorkouts = Program & {
  workouts: WorkoutWithExercises[];
};

/**
 * Build workout exercises with names from the library
 */
function buildWorkoutExercisesWithNames(
  workoutId: string,
  workoutExercises: WorkoutExercise[],
  exerciseLibrary: ExerciseLibraryItem[],
): WorkoutExerciseWithName[] {
  const libraryMap = new Map(exerciseLibrary.map((e) => [e.id, e]));

  return workoutExercises
    .filter((we) => we.workoutId === workoutId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((workoutExercise) => {
      const libraryItem = libraryMap.get(workoutExercise.exerciseId);
      return {
        ...workoutExercise,
        name: libraryItem?.name ?? "Unknown Exercise",
        notes: libraryItem?.notes ?? null,
      };
    });
}

/**
 * Build the workout hierarchy for a program from flat collections
 */
function buildProgramWorkouts(
  programId: string,
  workouts: Workout[],
  workoutExercises: WorkoutExercise[],
  exerciseLibrary: ExerciseLibraryItem[],
): WorkoutWithExercises[] {
  return workouts
    .filter((w) => w.programId === programId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((workout) => ({
      ...workout,
      exercises: buildWorkoutExercisesWithNames(
        workout.id,
        workoutExercises,
        exerciseLibrary,
      ),
    }));
}

/**
 * Hook to get all programs with their nested workouts and exercises
 */
export function useAllProgramsWithWorkouts(): {
  programs: ProgramWithWorkouts[];
  isLoading: boolean;
} {
  const { data: programs } = useLiveQuery((q) =>
    q.from({ program: programsCollection }),
  );
  const { data: workouts } = useLiveQuery((q) =>
    q.from({ workout: workoutsCollection }),
  );
  const { data: workoutExercises } = useLiveQuery((q) =>
    q.from({ exercise: exercisesCollection }),
  );
  const { data: exerciseLibrary } = useLiveQuery((q) =>
    q.from({ libraryItem: exerciseLibraryCollection }),
  );

  // Data is loading if any of the queries haven't returned yet
  const isLoading =
    programs === undefined ||
    workouts === undefined ||
    workoutExercises === undefined ||
    exerciseLibrary === undefined;

  const programsWithWorkouts: ProgramWithWorkouts[] = (programs ?? []).map(
    (program) => ({
      ...program,
      workouts: buildProgramWorkouts(
        program.id,
        workouts ?? [],
        workoutExercises ?? [],
        exerciseLibrary ?? [],
      ),
    }),
  );

  return { programs: programsWithWorkouts, isLoading };
}

/**
 * Hook to get the active program with its nested workouts and exercises
 */
export function useActiveProgram(): {
  activeProgram: ProgramWithWorkouts | null;
  isLoading: boolean;
} {
  const { programs, isLoading } = useAllProgramsWithWorkouts();
  const activeProgram = programs.find((p) => p.isActive) ?? null;
  return { activeProgram, isLoading };
}

/**
 * Hook to get a specific program by ID with its nested workouts and exercises
 */
export function useProgramById(programId: string): {
  program: ProgramWithWorkouts | null;
} {
  const { programs } = useAllProgramsWithWorkouts();
  const program = programs.find((p) => p.id === programId) ?? null;
  return { program };
}
