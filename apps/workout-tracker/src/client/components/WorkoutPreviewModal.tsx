import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "./ui/button";
import { skipToWorkout } from "@/client/actions/skipToWorkout";
import type { WorkoutWithExercises } from "@/client/hooks/useProgramData";
import { useDialogControl } from "@/client/hooks/useDialogControl";
import { Modal } from "./ui/modal";

interface WorkoutPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  workout: WorkoutWithExercises | null;
  programId: string;
  targetWorkoutIndex: number;
  /** Whether this is the current workout (no need to skip) */
  isCurrentWorkout: boolean;
  /** Whether the current workout has tracked set progress that would be lost */
  hasTrackedProgress: boolean;
  inProgressSessionId?: string;
}

export function WorkoutPreviewModal({
  isOpen,
  onClose,
  workout,
  programId,
  targetWorkoutIndex,
  isCurrentWorkout,
  hasTrackedProgress,
  inProgressSessionId,
}: WorkoutPreviewModalProps) {
  const dialogRef = useDialogControl(isOpen);
  const navigate = useNavigate();
  const [showConfirmation, setShowConfirmation] = useState(false);

  // Reset confirmation state when modal opens
  useEffect(() => {
    if (isOpen) {
      setShowConfirmation(false);
    }
  }, [isOpen]);

  const handleStartWorkout = async () => {
    // If this is the current workout, just navigate directly
    if (isCurrentWorkout) {
      onClose();
      navigate({ to: "/workout" });
      return;
    }

    // If there's tracked progress, show confirmation first
    if (hasTrackedProgress && !showConfirmation) {
      setShowConfirmation(true);
      return;
    }

    // Skip to the selected workout (abandoning session if needed)
    await skipToWorkout({
      programId,
      targetWorkoutIndex,
      sessionIdToAbandon: inProgressSessionId,
    });

    onClose();
    navigate({ to: "/workout" });
  };

  const handleCancel = () => {
    if (showConfirmation) {
      setShowConfirmation(false);
    } else {
      onClose();
    }
  };

  if (!workout) return null;

  return (
    <Modal dialogRef={dialogRef} onClose={onClose} boxClassName="max-w-md">
      {showConfirmation ? (
        // Confirmation view
        <>
          <h3 className="font-bold text-lg">Abandon Current Workout?</h3>
          <p className="py-4 text-base-content/70">
            You have a workout in progress. Starting this workout will abandon
            your current session. Are you sure you want to continue?
          </p>
          <div className="modal-action">
            <Button variant="ghost" onClick={handleCancel}>
              Go Back
            </Button>
            <Button variant="error" onClick={handleStartWorkout}>
              Abandon & Start
            </Button>
          </div>
        </>
      ) : (
        // Preview view
        <>
          <h3 className="font-bold text-lg">{workout.name}</h3>
          {workout.description && (
            <p className="text-base-content/70 mt-1">{workout.description}</p>
          )}

          {/* Exercise list */}
          <div className="mt-4">
            <h4 className="text-sm font-semibold text-base-content/70 mb-2">
              Exercises ({workout.exercises.length})
            </h4>
            <ul className="space-y-2">
              {workout.exercises.map((exercise) => (
                <li
                  key={exercise.id}
                  className="flex justify-between items-center text-sm py-2 border-b border-base-content/10 last:border-0"
                >
                  <span className="text-base-content">{exercise.name}</span>
                  <span className="text-base-content/50">
                    {exercise.sets} x {exercise.targetReps}
                    {exercise.weight ? ` @ ${exercise.weight}lbs` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="modal-action">
            <Button variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleStartWorkout}>
              {isCurrentWorkout
                ? hasTrackedProgress
                  ? "Continue"
                  : "Start"
                : "Start Workout"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
