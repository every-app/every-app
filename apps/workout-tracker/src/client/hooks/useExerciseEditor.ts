import { useState, useCallback } from "react";
import { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import {
  exercisesCollection,
  workoutsCollection,
  exerciseLibraryCollection,
} from "@/client/tanstack-db";
import { deleteWorkout as deleteWorkoutAction } from "@/client/actions/deleteWorkout";
import { DEFAULT_PROGRESSION_INCREMENT } from "@/client/lib/constants";
import type { WorkoutExerciseWithName, LocalExercise } from "./useProgramData";

type UseExerciseEditorOptions = {
  workoutId: string;
  exercises: WorkoutExerciseWithName[];
  workoutName: string;
  workoutDescription: string | null;
};

/**
 * Hook to manage exercise editing state and operations within a workout card.
 * Handles local state for edits, validation, drag-and-drop reordering, and persistence.
 *
 * Note: Exercise names come from the exercise library and cannot be changed here.
 * Only sets, reps, weight, and order can be modified.
 */
export function useExerciseEditor({
  workoutId,
  exercises,
  workoutName,
  workoutDescription,
}: UseExerciseEditorOptions) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [localExercises, setLocalExercises] = useState<LocalExercise[]>([]);
  const [localName, setLocalName] = useState("");
  const [localDescription, setLocalDescription] = useState("");

  // The exercises to display - use local copy when editing, otherwise use original exercises
  const displayExercises = isEditMode ? localExercises : exercises;

  const startEdit = useCallback(() => {
    // Create a deep copy of exercises when entering edit mode
    setLocalExercises(
      exercises.map((e) => ({
        id: e.id,
        exerciseId: e.exerciseId,
        name: e.name,
        notes: e.notes,
        sets: e.sets,
        targetReps: e.targetReps,
        weight: e.weight,
        progressionIncrement: e.progressionIncrement,
        sortOrder: e.sortOrder,
        workoutId: e.workoutId,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    );
    setLocalName(workoutName);
    setLocalDescription(workoutDescription ?? "");
    setIsEditMode(true);
  }, [exercises, workoutName, workoutDescription]);

  const cancelEdit = useCallback(() => {
    setLocalExercises([]);
    setLocalName("");
    setLocalDescription("");
    setIsEditMode(false);
  }, []);

  const handleExerciseChange = useCallback(
    (exerciseId: string, field: string, value: number | null | undefined) => {
      setLocalExercises((prev) =>
        prev.map((exercise) =>
          exercise.id === exerciseId
            ? { ...exercise, [field]: value }
            : exercise,
        ),
      );
    },
    [],
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) return;

    setLocalExercises((prev) => {
      const draggedIndex = prev.findIndex((e) => e.id === active.id);
      const targetIndex = prev.findIndex((e) => e.id === over.id);

      if (draggedIndex === -1 || targetIndex === -1) return prev;

      // Create a new sorted array
      const newExercises = [...prev];
      const [draggedExercise] = newExercises.splice(draggedIndex, 1);
      newExercises.splice(targetIndex, 0, draggedExercise);

      // Update sortOrder for all exercises based on their new position
      return newExercises.map((exercise, index) => ({
        ...exercise,
        sortOrder: index,
      }));
    });
  }, []);

  const deleteExercise = useCallback((exerciseId: string) => {
    setLocalExercises((prev) => {
      const filtered = prev.filter((e) => e.id !== exerciseId);
      // Re-index sortOrder after deletion
      return filtered.map((exercise, index) => ({
        ...exercise,
        sortOrder: index,
      }));
    });
  }, []);

  /**
   * Add a new exercise to the local state.
   * The exercise library entry is created immediately to avoid race conditions,
   * but the workout exercise is only created when saveChanges is called.
   */
  const addExercise = useCallback(
    (params: {
      id: string;
      exerciseId: string;
      name: string;
      sets: number;
      targetReps: number;
      weight: number | null;
    }) => {
      const now = new Date().toISOString();
      setLocalExercises((prev) => [
        ...prev,
        {
          id: params.id,
          exerciseId: params.exerciseId,
          name: params.name,
          notes: null,
          sets: params.sets,
          targetReps: params.targetReps,
          weight: params.weight,
          progressionIncrement: DEFAULT_PROGRESSION_INCREMENT,
          sortOrder: prev.length,
          workoutId,
          createdAt: now,
          updatedAt: now,
          isNew: true,
        },
      ]);
    },
    [workoutId],
  );

  const validateExercises = useCallback((): boolean => {
    for (const exercise of localExercises) {
      if (isNaN(exercise.sets) || exercise.sets < 1) {
        return false;
      }
      if (isNaN(exercise.targetReps) || exercise.targetReps < 1) {
        return false;
      }
      if (exercise.weight !== null && isNaN(exercise.weight)) {
        return false;
      }
    }
    return true;
  }, [localExercises]);

  const saveChanges = useCallback((): boolean => {
    if (!validateExercises()) {
      toast.error("Please enter valid numbers for all fields");
      return false;
    }

    if (!localName.trim()) {
      toast.error("Workout name is required");
      return false;
    }

    // Separate new exercises from existing ones
    const newExercises = localExercises.filter((e) => e.isNew);
    const existingExercises = localExercises.filter((e) => !e.isNew);

    // Find exercises that were deleted (only from original exercises, not newly added ones)
    const deletedExercises = exercises.filter(
      (original) => !localExercises.find((local) => local.id === original.id),
    );

    // Delete removed exercises
    deletedExercises.forEach((exercise) => {
      exercisesCollection.delete(exercise.id);
    });

    // Insert new exercises
    newExercises.forEach((exercise) => {
      exercisesCollection.insert({
        id: exercise.id,
        workoutId: exercise.workoutId,
        exerciseId: exercise.exerciseId,
        sets: exercise.sets,
        targetReps: exercise.targetReps,
        weight: exercise.weight,
        sortOrder: exercise.sortOrder,
        createdAt: exercise.createdAt,
        updatedAt: exercise.updatedAt,
      });
    });

    // Update all existing exercises with their current state
    if (existingExercises.length > 0) {
      const existingIds = existingExercises.map((e) => e.id);
      exercisesCollection.update(existingIds, (drafts) => {
        drafts.forEach((draft) => {
          const localExercise = existingExercises.find(
            (e) => e.id === draft.id,
          );
          if (localExercise) {
            draft.sets = localExercise.sets;
            draft.targetReps = localExercise.targetReps;
            draft.weight = localExercise.weight;
            draft.sortOrder = localExercise.sortOrder;
          }
        });
      });
    }

    // Update workout name and description
    workoutsCollection.update(workoutId, (draft) => {
      draft.name = localName.trim();
      draft.description = localDescription.trim() || null;
    });

    // Update progression increments in exercise library for exercises that changed
    const changedIncrements = localExercises.filter((local) => {
      const original = exercises.find((e) => e.id === local.id);
      return (
        original && original.progressionIncrement !== local.progressionIncrement
      );
    });

    // Batch update exercise library increments for consistency
    if (changedIncrements.length > 0) {
      const changedExerciseIds = changedIncrements.map((e) => e.exerciseId);
      exerciseLibraryCollection.update(changedExerciseIds, (drafts) => {
        drafts.forEach((draft) => {
          const local = changedIncrements.find(
            (e) => e.exerciseId === draft.id,
          );
          if (local) {
            draft.progressionIncrement = local.progressionIncrement;
          }
        });
      });
    }

    // Exit edit mode
    setLocalExercises([]);
    setLocalName("");
    setLocalDescription("");
    setIsEditMode(false);
    toast("Changes saved");
    return true;
  }, [
    exercises,
    localExercises,
    localName,
    localDescription,
    workoutId,
    validateExercises,
  ]);

  const deleteWorkout = useCallback(async () => {
    // Use atomic action to delete workout and all its exercises
    await deleteWorkoutAction({
      workoutId,
      exerciseIds: exercises.map((e) => e.id),
    });
    setIsEditMode(false);
    toast("Workout deleted");
  }, [workoutId, exercises]);

  return {
    isEditMode,
    displayExercises,
    localName,
    localDescription,
    setLocalName,
    setLocalDescription,
    startEdit,
    cancelEdit,
    handleExerciseChange,
    handleDragEnd,
    deleteExercise,
    addExercise,
    saveChanges,
    deleteWorkout,
  };
}
