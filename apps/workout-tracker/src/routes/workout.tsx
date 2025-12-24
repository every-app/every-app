import {
  createFileRoute,
  Link,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useIsMobile } from "@/client/hooks/use-mobile";
import {
  useWorkoutSession,
  useSetLogTracking,
  useWorkoutCompletion,
} from "@/client/hooks/useWorkoutSession";
import { TabBar } from "@/client/components/TabBar";
import { Card, CardTitle, CardContent } from "@/client/components/ui/card";
import { Button } from "@/client/components/ui/button";
import { EmptyState } from "@/client/components/ui/empty-state";
import { RepButton } from "@/client/components/ui/rep-button";
import { ProgressBar } from "@/client/components/ui/progress-bar";
import { Dumbbell, ArrowLeft, Check, ChevronRight } from "lucide-react";
import type { WorkoutExerciseWithName } from "@/client/hooks/useProgramData";

export const Route = createFileRoute("/workout")({
  component: ActiveWorkout,
});

function ActiveWorkout() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const location = useLocation();

  // Use extracted hooks for session management
  const { workoutData, sessionId, sessionSetLogs } = useWorkoutSession();

  // Derive set tracking state from setLogs
  const { setReps, setTouched } = useSetLogTracking(
    workoutData,
    sessionSetLogs,
  );

  // Get completion tracking and handlers
  const {
    completedExercises,
    totalExercises,
    hasAnyProgress,
    isCompleting,
    handleRepClick,
    handleCompleteWorkout,
  } = useWorkoutCompletion(workoutData, sessionId, sessionSetLogs, setTouched);

  if (!workoutData) {
    return (
      <>
        <div className="page-container">
          <div className="px-4 pt-6">
            <EmptyState
              icon={<Dumbbell className="h-12 w-12 mx-auto" />}
              title="No Active Workout"
              description="Set an active program to start working out."
              action={
                <Link to="/programs">
                  <Button variant="primary">Browse Programs</Button>
                </Link>
              }
            />
          </div>
        </div>
        {isMobile && <TabBar currentPath={location.pathname} />}
      </>
    );
  }

  const { program, workout } = workoutData;

  return (
    <>
      <div className="page-container">
        <div className="px-4 pt-6 pb-24">
          {/* Back Link */}
          <Link
            to="/"
            className="inline-flex items-center text-xs font-mono uppercase tracking-widest text-base-content/50 hover:text-base-content transition-colors mb-6"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Home
          </Link>

          {/* Header */}
          <div className="page-header mb-6 px-0">
            <div>
              <h1 className="page-title">{workout.name}</h1>
              <Link
                to="/programs/$programId"
                params={{ programId: program.id }}
                className="text-base-content/70 hover:text-base-content transition-colors mt-1 inline-block"
              >
                {program.name}
              </Link>
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={!hasAnyProgress || isCompleting}
              onClick={() => handleCompleteWorkout(() => navigate({ to: "/" }))}
              className="gap-2"
            >
              <Check className="h-4 w-4" />
              {isCompleting ? "Saving..." : "Finish"}
            </Button>
          </div>

          {/* Progress */}
          <div className="mb-8">
            <ProgressBar
              value={completedExercises}
              max={totalExercises}
              className="mb-2 [&::-webkit-progress-value]:bg-gray-400 [&::-moz-progress-bar]:bg-gray-400"
            />
            <p className="text-sm text-base-content/60">
              {completedExercises} of {totalExercises} exercises completed
            </p>
          </div>

          {/* Exercises */}
          <div className="space-y-6">
            {workout.exercises.map((exercise) => {
              const reps = setReps[exercise.id] ?? [];
              const touched = setTouched[exercise.id] ?? [];
              const isCompleted = touched.length > 0 && touched.every(Boolean);

              return (
                <ExerciseCard
                  key={exercise.id}
                  exercise={exercise}
                  reps={reps}
                  touched={touched}
                  isCompleted={isCompleted}
                  onRepClick={(setIndex) =>
                    handleRepClick(exercise.id, setIndex)
                  }
                  programId={program.id}
                />
              );
            })}
          </div>
        </div>
      </div>

      {isMobile && <TabBar currentPath={location.pathname} />}
    </>
  );
}

function ExerciseCard({
  exercise,
  reps,
  touched,
  isCompleted,
  onRepClick,
  programId,
}: {
  exercise: WorkoutExerciseWithName;
  reps: number[];
  touched: boolean[];
  isCompleted: boolean;
  onRepClick: (setIndex: number) => void;
  programId: string;
}) {
  return (
    <Card
      className={`shadow-sm transition-all ${isCompleted ? "opacity-60" : ""}`}
    >
      <CardContent className="card-body">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-start justify-between mb-1">
              <CardTitle className="text-lg">{exercise.name}</CardTitle>
              <Link
                to="/programs/$programId"
                params={{ programId }}
                className="opacity-40 hover:opacity-100 transition-opacity"
              >
                <ChevronRight className="h-5 w-5" />
              </Link>
            </div>
            <p className="text-sm opacity-50 mb-4 font-bold">
              {exercise.sets} x {exercise.targetReps}
              {exercise.weight && ` @ ${exercise.weight} lbs`}
            </p>

            {/* Rep counter buttons */}
            <div className="grid grid-cols-5 gap-2 sm:gap-3">
              {reps.map((repCount, index) => (
                <RepButton
                  key={index}
                  reps={repCount}
                  targetReps={exercise.targetReps}
                  isTouched={touched[index] ?? false}
                  onClick={() => onRepClick(index)}
                />
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
