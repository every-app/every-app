import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { useProgramById } from "@/client/hooks/useProgramData";
import { nanoid } from "nanoid";
import { useProgramMutations } from "@/client/queries/programs";
import { useWorkoutMutations } from "@/client/queries/workouts";
import { Button } from "@/client/components/ui/button";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { InfoModal } from "@/client/components/ui/info-modal";
import { WorkoutCard } from "@/client/components/WorkoutCard";
import { MobileSlideLink } from "@/client/components/MobileSlideLink";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { useIsMobile } from "@/client/hooks/use-mobile";

type ProgramSearchParams = {
  newProgramSource?: "custom" | "template";
};

export const Route = createFileRoute("/programs_/$programId")({
  component: ProgramDetailPage,
  validateSearch: (search: Record<string, unknown>): ProgramSearchParams => {
    const source = search.newProgramSource;
    return {
      newProgramSource:
        source === "custom" || source === "template" ? source : undefined,
    };
  },
});

function ProgramDetailPage() {
  const { programId } = Route.useParams();
  const { newProgramSource } = Route.useSearch();
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const { program } = useProgramById(programId);
  const programMutations = useProgramMutations();
  const workoutMutations = useWorkoutMutations();

  const [isUpdating, setIsUpdating] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [showTemplateWelcomeModal, setShowTemplateWelcomeModal] = useState(
    newProgramSource === "template",
  );

  // Editable title and description state
  const [editedName, setEditedName] = useState(program?.name ?? "");
  const [editedDescription, setEditedDescription] = useState(
    program?.description ?? "",
  );
  const [hasHeaderChanges, setHasHeaderChanges] = useState(false);
  const [isSavingHeader, setIsSavingHeader] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea based on content
  const adjustTextareaHeight = () => {
    const textarea = descriptionRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  };

  // Sync local state when program data loads or changes externally
  useEffect(() => {
    if (program && !hasHeaderChanges) {
      setEditedName(program.name);
      setEditedDescription(program.description ?? "");
    }
  }, [program?.name, program?.description, hasHeaderChanges]);

  // Adjust textarea height when description changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [editedDescription]);

  const handleNameChange = (value: string) => {
    setEditedName(value);
    setHasHeaderChanges(
      value !== program?.name ||
        editedDescription !== (program?.description ?? ""),
    );
  };

  const handleDescriptionChange = (value: string) => {
    setEditedDescription(value);
    setHasHeaderChanges(
      editedName !== program?.name || value !== (program?.description ?? ""),
    );
  };

  const handleSaveHeader = async () => {
    if (!program || !editedName.trim()) return;
    setIsSavingHeader(true);
    try {
      await programMutations.update.mutateAsync({
        id: program.id,
        name: editedName.trim(),
        description: editedDescription.trim(),
      });
      setHasHeaderChanges(false);
      toast("Program updated");
    } catch (error) {
      console.error("Failed to update program:", error);
      toast.error("Failed to update program");
    } finally {
      setIsSavingHeader(false);
    }
  };

  const handleSetActive = async () => {
    if (!program) return;
    setIsUpdating(true);
    try {
      await programMutations.update.mutateAsync({
        id: program.id,
        isActive: true,
      });
      toast("Program set as active");
    } catch (error) {
      console.error("Failed to set active program:", error);
      toast.error("Failed to set active program");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRemoveProgram = async () => {
    if (!program) return;
    try {
      await programMutations.remove.mutateAsync({ id: program.id });
      toast("Program removed");
      navigate({ to: "/programs" });
    } catch (error) {
      console.error("Failed to remove program:", error);
      toast.error("Failed to remove program");
    }
  };

  const handleAddWorkout = async () => {
    if (!program) return;
    // Guard against double-clicks: two in-flight creates would read the same
    // workouts.length and produce duplicate names/sortOrders.
    if (workoutMutations.create.isPending) return;
    try {
      const workoutId = nanoid();
      const nextSortOrder = program.workouts.length;

      await workoutMutations.create.mutateAsync([
        {
          id: workoutId,
          programId: program.id,
          name: `Workout ${nextSortOrder + 1}`,
          description: null,
          sortOrder: nextSortOrder,
        },
      ]);

      toast("Workout added");
    } catch (error) {
      console.error("Failed to add workout:", error);
      toast.error("Failed to add workout");
    }
  };

  if (!program) {
    return (
      <div className="page-container">
        <div className="px-4 pt-12 pb-4">
          <div className="text-center py-12">
            <h2 className="text-2xl font-bold mb-2">Program Not Found</h2>
            <p className="text-base-content/70 mb-4">
              The program you're looking for doesn't exist.
            </p>
            <Button
              variant="default"
              onClick={() => navigate({ to: "/programs" })}
            >
              Back to Programs
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page-container">
        <div
          className={`px-4 pt-6 ${isMobile && !program.isActive ? "pb-24" : "pb-4"}`}
        >
          {/* Back Link */}
          <MobileSlideLink
            to="/programs"
            direction="right"
            className="inline-flex items-center text-xs font-mono uppercase tracking-widest text-base-content/50 hover:text-base-content transition-colors mb-6"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Programs
          </MobileSlideLink>

          {/* Program Header */}
          <div className="mb-6 px-0">
            <div className="flex items-center gap-3 mb-1">
              <input
                type="text"
                value={editedName}
                onChange={(e) => handleNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hasHeaderChanges) {
                    e.preventDefault();
                    handleSaveHeader();
                  }
                }}
                className="page-title bg-transparent border-none outline-none focus:ring-0 p-0 flex-1"
                placeholder="Program name"
              />
              {program.isActive && (
                <span className="badge-active shrink-0">Active</span>
              )}
              {!isMobile && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowRemoveModal(true)}
                  className="shrink-0"
                >
                  Remove
                </Button>
              )}
              {!program.isActive && !isMobile && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSetActive}
                  disabled={isUpdating}
                  className="shrink-0"
                >
                  {isUpdating ? "Setting..." : "Set as Active"}
                </Button>
              )}
            </div>
            <textarea
              ref={descriptionRef}
              value={editedDescription}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && hasHeaderChanges) {
                  e.preventDefault();
                  handleSaveHeader();
                }
              }}
              className="text-base-content/70 bg-transparent border-none outline-none focus:ring-0 p-0 w-full resize-none overflow-hidden mt-2"
              placeholder="Add a description..."
              rows={1}
            />
            {hasHeaderChanges && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveHeader}
                disabled={isSavingHeader || !editedName.trim()}
                className="mt-2"
              >
                {isSavingHeader ? "Saving..." : "Save Changes"}
              </Button>
            )}
          </div>

          {/* Progression Settings */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-base-content mb-2">
              Progression Mode
            </h3>
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="progressionMode"
                  className="radio radio-primary radio-sm"
                  checked={program.progressionMode === "linear"}
                  onChange={async () => {
                    await programMutations.update.mutateAsync({
                      id: program.id,
                      progressionMode: "linear",
                    });
                    toast("Linear progression enabled");
                  }}
                />
                <span className="text-sm text-base-content/80">
                  Linear - Add fixed weight when all reps in set are completed
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="progressionMode"
                  className="radio radio-primary radio-sm"
                  checked={program.progressionMode === "smart"}
                  onChange={async () => {
                    await programMutations.update.mutateAsync({
                      id: program.id,
                      progressionMode: "smart",
                    });
                    toast("Smart progression enabled");
                  }}
                />
                <span className="text-sm text-base-content/80">
                  Smart - Calculate weights using estimated 1RM based on
                  previous workout data
                </span>
              </label>
            </div>
          </div>

          {/* Workouts */}
          <div className="space-y-6">
            {program.workouts.map((workout) => (
              <WorkoutCard key={workout.id} workout={workout} />
            ))}

            {/* Add Workout Button */}
            <Button
              variant="outline"
              className="w-full"
              onClick={handleAddWorkout}
            >
              Add Workout
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile: Sticky bottom banner when not active */}
      {!program.isActive && isMobile && (
        <div className="fixed bottom-0 left-0 right-0 bg-base-100 border-t border-base-300 p-4 shadow-lg">
          <div className="flex gap-3">
            <Button
              variant="primary"
              className="flex-1"
              onClick={handleSetActive}
              disabled={isUpdating}
            >
              {isUpdating ? "Setting..." : "Set as Active"}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowRemoveModal(true)}
            >
              Remove
            </Button>
          </div>
        </div>
      )}

      {/* Remove Program Confirmation Modal */}
      <ConfirmationModal
        isOpen={showRemoveModal}
        onClose={() => setShowRemoveModal(false)}
        onConfirm={handleRemoveProgram}
        title="Remove Program"
        description={`Are you sure you want to remove "${program.name}" from your programs?\n\nThis will not affect your workout history.`}
        confirmText="Remove"
      />

      {/* Welcome Modal for programs created from templates */}
      <InfoModal
        isOpen={showTemplateWelcomeModal}
        onClose={() => {
          setShowTemplateWelcomeModal(false);
          // Clear the query param from the URL
          navigate({
            to: "/programs/$programId",
            params: { programId },
            search: {},
            replace: true,
          });
        }}
        title="Program Saved"
        description="Your program has been saved! You can now customize it by entering your weights and making any changes you'd like to the exercises, sets, and reps."
      />
    </>
  );
}
