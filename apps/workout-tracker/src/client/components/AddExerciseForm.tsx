import { useState } from "react";
import { nanoid } from "nanoid";
import { exerciseLibraryCollection } from "@/client/tanstack-db";
import { Button } from "@/client/components/ui/button";
import { toast } from "sonner";

type AddExerciseFormProps = {
  onCancel: () => void;
  onSuccess: () => void;
  /**
   * Callback to add exercise to local state instead of directly to DB.
   * When provided, the form will create the exercise library entry immediately
   * (to avoid race conditions) but defer the workout exercise creation.
   */
  onAddExercise: (params: {
    id: string;
    exerciseId: string;
    name: string;
    sets: number;
    targetReps: number;
    weight: number | null;
  }) => void;
};

export function AddExerciseForm({
  onCancel,
  onSuccess,
  onAddExercise,
}: AddExerciseFormProps) {
  const [name, setName] = useState("");
  const [sets, setSets] = useState<number | undefined>(3);
  const [targetReps, setTargetReps] = useState<number | undefined>(10);
  const [weight, setWeight] = useState<number | undefined>(undefined);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Exercise name is required");
      return;
    }

    if (!sets || !targetReps) {
      toast.error("Sets and reps are required");
      return;
    }

    const exerciseLibraryId = nanoid();
    const workoutExerciseId = nanoid();
    const now = new Date().toISOString();

    // Create exercise library entry immediately to avoid race conditions
    exerciseLibraryCollection.insert({
      id: exerciseLibraryId,
      userId: "", // Will be set by server on sync
      name: name.trim(),
      notes: null,
      createdAt: now,
      updatedAt: now,
    });

    // Add to local state - will be persisted on save
    onAddExercise({
      id: workoutExerciseId,
      exerciseId: exerciseLibraryId,
      name: name.trim(),
      sets,
      targetReps,
      weight: weight ?? null,
    });

    onSuccess();
  };

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={(e) => {
        // Prevent Enter key from bubbling up to parent handlers
        if (e.key === "Enter") {
          e.stopPropagation();
        }
      }}
      className="space-y-3 p-3 bg-base-200 rounded"
    >
      {/* Exercise name input */}
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Exercise name"
        className="w-full px-3 py-2 text-sm bg-base-100 border border-base-300 rounded-md focus:ring-2 focus:ring-primary focus:outline-none"
        autoFocus
      />

      {/* Workout-specific configuration */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="exercise-table-header mb-1 block">Sets</label>
          <input
            type="number"
            value={sets ?? ""}
            onChange={(e) =>
              setSets(e.target.value ? Number(e.target.value) : undefined)
            }
            className="exercise-input w-full bg-base-100"
            min={1}
            max={10}
          />
        </div>
        <div>
          <label className="exercise-table-header mb-1 block">Reps</label>
          <input
            type="number"
            value={targetReps ?? ""}
            onChange={(e) =>
              setTargetReps(e.target.value ? Number(e.target.value) : undefined)
            }
            className="exercise-input w-full bg-base-100"
            min={1}
            max={50}
          />
        </div>
        <div>
          <label className="exercise-table-header mb-1 block">Lbs</label>
          <input
            type="number"
            value={weight ?? ""}
            onChange={(e) =>
              setWeight(e.target.value ? Number(e.target.value) : undefined)
            }
            className="exercise-input w-full bg-base-100"
            placeholder="-"
            step={5}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!name.trim() || !sets || !targetReps}
        >
          Add Exercise
        </Button>
      </div>
    </form>
  );
}
