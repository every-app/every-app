import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { programTemplates } from "@/data/program-templates";
import type { WorkoutTemplate } from "@/data/program-templates";
import { Button } from "@/client/components/ui/button";
import { MobileSlideLink } from "@/client/components/MobileSlideLink";
import { ArrowLeft } from "lucide-react";
import {
  createProgramFromTemplateInput,
  useProgramMutations,
} from "@/client/queries/programs";
import { capitalize } from "@/client/lib/utils";
import { useIsMobile } from "@/client/hooks/use-mobile";

export const Route = createFileRoute("/templates_/$templateId")({
  component: TemplatePreviewPage,
});

function TemplatePreviewPage() {
  const { templateId } = Route.useParams();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const { createFromTemplate } = useProgramMutations();

  const template = programTemplates.find((t) => t.id === templateId);

  const handleSaveProgram = async (setAsActive: boolean) => {
    if (!template || isCreating) return;
    setIsCreating(true);

    try {
      const input = createProgramFromTemplateInput(template, setAsActive);
      await createFromTemplate.mutateAsync(input);

      navigate({
        to: "/programs/$programId",
        params: { programId: input.program.id },
        search: { newProgramSource: "template" },
      });
    } catch (error) {
      console.error("Failed to create program:", error);
      setIsCreating(false);
    }
  };

  if (!template) {
    return (
      <div className="page-container">
        <div className="px-4 pt-12 pb-4">
          <div className="text-center py-12">
            <h2 className="text-2xl font-bold mb-2">Template Not Found</h2>
            <p className="text-base-content/70 mb-4">
              The template you're looking for doesn't exist.
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
        <div className={`px-4 pt-6 ${isMobile ? "pb-24" : "pb-4"}`}>
          {/* Back Link */}
          <MobileSlideLink
            to="/programs"
            direction="right"
            className="inline-flex items-center text-xs font-mono uppercase tracking-widest text-base-content/50 hover:text-base-content transition-colors mb-6"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Programs
          </MobileSlideLink>

          {/* Template Header */}
          <div className="mb-6 px-0">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="page-title">{template.name}</h1>
              <span className="tag-pill shrink-0">Template</span>
              <div className="flex-1" />
              {!isMobile && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSaveProgram(false)}
                    disabled={isCreating}
                    className="shrink-0"
                  >
                    Save
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleSaveProgram(true)}
                    disabled={isCreating}
                    className="shrink-0"
                  >
                    Start Program
                  </Button>
                </>
              )}
            </div>
            <p className="text-base-content/70 mt-2">{template.description}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <span className="tag-pill">
                {template.workouts.length} days/week
              </span>
              <span className="tag-pill">
                {capitalize(template.difficulty)}
              </span>
            </div>
          </div>

          {/* Workouts */}
          <div className="space-y-6">
            {template.workouts.map((workout, index) => (
              <TemplateWorkoutCard key={index} workout={workout} />
            ))}
          </div>
        </div>
      </div>

      {/* Mobile: Sticky bottom banner */}
      {isMobile && (
        <div className="fixed bottom-0 left-0 right-0 bg-base-100 border-t border-base-300 p-4 shadow-lg">
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => handleSaveProgram(false)}
              disabled={isCreating}
            >
              Save
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              onClick={() => handleSaveProgram(true)}
              disabled={isCreating}
            >
              Start Program
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function TemplateWorkoutCard({ workout }: { workout: WorkoutTemplate }) {
  return (
    <div className="workout-card">
      {/* Workout Header */}
      <div className="workout-card-header">
        <div className="flex-1">
          <h2 className="workout-card-title">{workout.name}</h2>
          {workout.description && (
            <p className="workout-card-description">{workout.description}</p>
          )}
        </div>
      </div>

      {/* Exercise Table */}
      <div className="workout-card-body">
        {workout.exercises.length > 0 && (
          <div className="exercise-table">
            {/* Table Header */}
            <div className="flex items-center gap-3 mb-4">
              <span className="exercise-table-header flex-1 min-w-16">
                Exercise
              </span>
              <span className="exercise-table-header text-center shrink-0 w-12">
                Lbs
              </span>
              <span className="exercise-table-header text-center shrink-0 w-12">
                Sets
              </span>
              <span className="exercise-table-header text-center shrink-0 w-12">
                Reps
              </span>
            </div>

            {/* Exercise Rows */}
            <div className="divide-y divide-base-200">
              {workout.exercises.map((exercise, index) => (
                <div key={index} className="flex items-center gap-3 py-3">
                  <span className="text-base-content font-medium flex-1 min-w-16 break-words">
                    {exercise.name}
                  </span>
                  <span className="text-base-content/50 text-center shrink-0 w-12">
                    {exercise.weight ?? "—"}
                  </span>
                  <span className="text-base-content text-center shrink-0 w-12">
                    {exercise.sets}
                  </span>
                  <span className="text-base-content text-center shrink-0 w-12">
                    {exercise.targetReps}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
