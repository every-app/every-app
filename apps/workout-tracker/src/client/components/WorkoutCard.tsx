import { useState } from "react";
import { Button } from "@/client/components/ui/button";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { Trash2, Pencil } from "lucide-react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDraggableSensors } from "@/client/hooks/useDraggableSensors";
import { useExerciseEditor } from "@/client/hooks/useExerciseEditor";
import { SortableExerciseRow } from "@/client/components/SortableExerciseRow";
import { AddExerciseForm } from "@/client/components/AddExerciseForm";
import { EXERCISE_TABLE_GRID } from "@/client/lib/constants";
import type { WorkoutWithExercises } from "@/client/hooks/useProgramData";

type WorkoutCardProps = {
  workout: WorkoutWithExercises;
};

export function WorkoutCard({ workout }: WorkoutCardProps) {
  const [isAddingExercise, setIsAddingExercise] = useState(false);
  const [showDeleteWorkoutModal, setShowDeleteWorkoutModal] = useState(false);
  const sensors = useDraggableSensors();

  const {
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
  } = useExerciseEditor({
    workoutId: workout.id,
    exercises: workout.exercises,
    workoutName: workout.name,
    workoutDescription: workout.description,
  });

  const handleEditButtonClick = () => {
    if (isEditMode) {
      saveChanges();
    } else {
      startEdit();
    }
  };

  return (
    <div className="workout-card">
      {/* Workout Header */}
      <div className="workout-card-header">
        {isEditMode ? (
          <div className="space-y-3">
            {/* Edit mode: Title and description inputs take full width */}
            <input
              type="text"
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveChanges();
                }
              }}
              className="workout-card-title w-full bg-base-200 rounded px-2 py-1 border border-base-300 focus:border-primary focus:outline-none"
              placeholder="Workout name"
            />
            <textarea
              value={localDescription}
              onChange={(e) => setLocalDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveChanges();
                }
              }}
              className="workout-card-description w-full bg-base-200 rounded px-2 py-1 border border-base-300 focus:border-primary focus:outline-none resize-none text-base-content"
              placeholder="Add a description..."
              rows={2}
            />
            {/* Action buttons on their own row */}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleEditButtonClick}
              >
                <Pencil className="h-4 w-4 mr-2" />
                Done
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteWorkoutModal(true)}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <h2 className="workout-card-title">{workout.name}</h2>
              {workout.description && (
                <p className="workout-card-description">
                  {workout.description}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="ghost" size="sm" onClick={handleEditButtonClick}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Exercise Table */}
      <div className="workout-card-body">
        {/* Empty state when no exercises and not in edit mode */}
        {displayExercises.length === 0 && !isEditMode && (
          <div className="text-center py-6">
            <p className="text-base-content/50 text-sm mb-3">
              No exercises yet
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                startEdit();
                setIsAddingExercise(true);
              }}
            >
              Add Exercise
            </Button>
          </div>
        )}

        {displayExercises.length > 0 && (
          <div className="exercise-table overflow-x-auto">
            {/* Table Header */}
            <div
              className={`grid ${isEditMode ? EXERCISE_TABLE_GRID.editMode : EXERCISE_TABLE_GRID.viewMode} gap-3 mb-4 items-center min-w-max`}
            >
              {isEditMode && <span className="exercise-table-header"></span>}
              <span className="exercise-table-header">Exercise</span>
              <span className="exercise-table-header text-center">Sets</span>
              <span className="exercise-table-header text-center">Reps</span>
              <span className="exercise-table-header text-center">Lbs</span>
              <span className="exercise-table-header text-center">Incr By</span>
              {isEditMode && <span className="exercise-table-header"></span>}
            </div>

            {/* Exercise Rows */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={displayExercises.map((e) => e.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="divide-y divide-base-200">
                  {displayExercises.map((exercise) => (
                    <SortableExerciseRow
                      key={exercise.id}
                      exercise={exercise}
                      isEditMode={isEditMode}
                      onExerciseChange={handleExerciseChange}
                      onDelete={deleteExercise}
                      onSubmit={saveChanges}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* Add Exercise - only show in edit mode */}
        {isEditMode && (
          <div className={displayExercises.length > 0 ? "pt-4 mt-2" : ""}>
            {isAddingExercise ? (
              <AddExerciseForm
                onCancel={() => setIsAddingExercise(false)}
                onSuccess={() => setIsAddingExercise(false)}
                onAddExercise={addExercise}
              />
            ) : (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAddingExercise(true)}
                >
                  Add Exercise
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete Workout Confirmation Modal */}
      <ConfirmationModal
        isOpen={showDeleteWorkoutModal}
        onClose={() => setShowDeleteWorkoutModal(false)}
        onConfirm={deleteWorkout}
        title="Delete Workout"
        description={`Are you sure you want to delete "${workout.name}" from this program?\n\nThis action cannot be undone. However, you won't lose this workout from any previous workouts in your history.`}
        confirmText="Delete Workout"
      />
    </div>
  );
}
