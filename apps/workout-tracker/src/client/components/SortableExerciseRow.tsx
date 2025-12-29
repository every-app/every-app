import { useState, useEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/client/components/ui/button";
import { GripVertical, Trash2 } from "lucide-react";
import {
  EXERCISE_TABLE_GRID,
  DEFAULT_PROGRESSION_INCREMENT,
} from "@/client/lib/constants";

type SortableExerciseRowProps = {
  exercise: {
    id: string;
    name: string;
    sets: number;
    targetReps: number;
    weight: number | null;
    progressionIncrement: number;
  };
  isEditMode: boolean;
  onExerciseChange: (
    exerciseId: string,
    field: string,
    value: number | null | undefined,
  ) => void;
  onDelete: (exerciseId: string) => void;
  onSubmit: () => void;
};

export function SortableExerciseRow({
  exercise,
  isEditMode,
  onExerciseChange,
  onDelete,
  onSubmit,
}: SortableExerciseRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: exercise.id,
    disabled: !isEditMode,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Use string state for inputs to handle partial input gracefully
  const [localSets, setLocalSets] = useState(String(exercise.sets));
  const [localReps, setLocalReps] = useState(String(exercise.targetReps));
  const [localWeight, setLocalWeight] = useState(
    exercise.weight != null ? String(exercise.weight) : "",
  );
  const [localIncrement, setLocalIncrement] = useState(
    String(exercise.progressionIncrement),
  );

  // Sync local state when exercise data changes
  useEffect(() => {
    setLocalSets(String(exercise.sets));
    setLocalReps(String(exercise.targetReps));
    setLocalWeight(exercise.weight != null ? String(exercise.weight) : "");
    setLocalIncrement(String(exercise.progressionIncrement));
  }, [
    exercise.sets,
    exercise.targetReps,
    exercise.weight,
    exercise.progressionIncrement,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  // Only allow numeric input (digits only)
  const handleNumericInput = (value: string): string => {
    return value.replace(/[^0-9]/g, "");
  };

  const isValidNumber = (value: string): boolean => {
    return value !== "" && !isNaN(Number(value)) && Number(value) >= 1;
  };

  const isValidWeight = (value: string): boolean => {
    return value === "" || (!isNaN(Number(value)) && Number(value) >= 0);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`exercise-row grid ${isEditMode ? EXERCISE_TABLE_GRID.editMode : EXERCISE_TABLE_GRID.viewMode} gap-3 items-center min-w-max ${isDragging ? "opacity-50" : ""}`}
    >
      {isEditMode && (
        <div
          {...attributes}
          {...listeners}
          className="h-10 flex items-center justify-center cursor-grab active:cursor-grabbing text-base-content/50 hover:text-base-content"
        >
          <GripVertical className="h-4 w-4" />
        </div>
      )}
      <span className="exercise-name truncate">{exercise.name}</span>
      <input
        type="text"
        inputMode="numeric"
        value={localSets}
        onChange={(e) => {
          const filtered = handleNumericInput(e.target.value);
          setLocalSets(filtered);
          const numVal = filtered ? Number(filtered) : NaN;
          onExerciseChange(exercise.id, "sets", numVal);
        }}
        onKeyDown={handleKeyDown}
        disabled={!isEditMode}
        className={`exercise-input ${isEditMode && !isValidNumber(localSets) ? "border-error" : ""}`}
      />
      <input
        type="text"
        inputMode="numeric"
        value={localReps}
        onChange={(e) => {
          const filtered = handleNumericInput(e.target.value);
          setLocalReps(filtered);
          const numVal = filtered ? Number(filtered) : NaN;
          onExerciseChange(exercise.id, "targetReps", numVal);
        }}
        onKeyDown={handleKeyDown}
        disabled={!isEditMode}
        className={`exercise-input ${isEditMode && !isValidNumber(localReps) ? "border-error" : ""}`}
      />
      <input
        type="text"
        inputMode="numeric"
        value={isEditMode ? localWeight : (exercise.weight ?? "—")}
        onChange={(e) => {
          const filtered = handleNumericInput(e.target.value);
          setLocalWeight(filtered);
          const numVal = filtered ? Number(filtered) : null;
          onExerciseChange(exercise.id, "weight", numVal);
        }}
        onKeyDown={handleKeyDown}
        disabled={!isEditMode}
        className={`exercise-input ${isEditMode && !isValidWeight(localWeight) ? "border-error" : ""}`}
      />
      <input
        type="text"
        inputMode="numeric"
        value={isEditMode ? localIncrement : exercise.progressionIncrement}
        onChange={(e) => {
          const filtered = handleNumericInput(e.target.value);
          setLocalIncrement(filtered);
          const numVal = filtered
            ? Number(filtered)
            : DEFAULT_PROGRESSION_INCREMENT;
          onExerciseChange(exercise.id, "progressionIncrement", numVal);
        }}
        onKeyDown={handleKeyDown}
        disabled={!isEditMode}
        className={`exercise-input ${isEditMode && !isValidNumber(localIncrement) ? "border-error" : ""}`}
      />
      {isEditMode && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(exercise.id)}
          className="h-10 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
