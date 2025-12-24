import { useState } from "react";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useIsMobile } from "@/client/hooks/use-mobile";
import {
  useActiveProgram,
  type WorkoutWithExercises,
} from "@/client/hooks/useProgramData";
import { sessionsCollection, setLogsCollection } from "@/client/tanstack-db";
import { TabBar } from "@/client/components/TabBar";
import { Button } from "@/client/components/ui/button";
import { EmptyState } from "@/client/components/ui/empty-state";
import { WorkoutPreviewModal } from "@/client/components/WorkoutPreviewModal";
import { Dumbbell } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const isMobile = useIsMobile();
  const location = useLocation();

  const { activeProgram, isLoading } = useActiveProgram();

  // State for workout preview modal
  const [previewWorkout, setPreviewWorkout] =
    useState<WorkoutWithExercises | null>(null);
  const [previewWorkoutIndex, setPreviewWorkoutIndex] = useState<number>(0);

  // Live query for sessions to check if workout has been started
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ session: sessionsCollection }),
  );

  // Live query for set logs to check if progress has been tracked
  const { data: setLogs } = useLiveQuery((q) =>
    q.from({ setLog: setLogsCollection }),
  );

  // Current workout and upcoming workouts
  const currentWorkout =
    activeProgram && activeProgram.workouts.length > 0
      ? activeProgram.workouts[activeProgram.currentWorkoutIndex]
      : null;

  // Check if current workout has an in-progress session
  const inProgressSession = currentWorkout
    ? sessions?.find(
        (s) => s.workoutId === currentWorkout.id && s.status === "in_progress",
      )
    : undefined;

  const hasInProgressSession = !!inProgressSession;

  // Check if the in-progress session has any tracked sets
  const hasTrackedProgress = inProgressSession
    ? (setLogs?.some((log) => log.sessionId === inProgressSession.id) ?? false)
    : false;

  const upcomingWorkouts =
    activeProgram && activeProgram.workouts.length > 0
      ? [
          ...activeProgram.workouts.slice(
            activeProgram.currentWorkoutIndex + 1,
          ),
          ...activeProgram.workouts.slice(0, activeProgram.currentWorkoutIndex),
        ]
      : [];

  // Get the actual index of a workout in the program's workout array
  const getWorkoutIndex = (workout: WorkoutWithExercises): number => {
    if (!activeProgram) return 0;
    return activeProgram.workouts.findIndex((w) => w.id === workout.id);
  };

  const handleWorkoutClick = (workout: WorkoutWithExercises) => {
    setPreviewWorkout(workout);
    setPreviewWorkoutIndex(getWorkoutIndex(workout));
  };

  const handleClosePreview = () => {
    setPreviewWorkout(null);
  };

  // Show empty screen while loading to avoid flash of empty state
  if (isLoading) {
    return (
      <>
        <div className="page-container" />
        {isMobile && <TabBar currentPath={location.pathname} />}
      </>
    );
  }

  if (!activeProgram) {
    return (
      <>
        <div className="page-container">
          <div className="px-4 pt-6">
            <EmptyState
              icon={<Dumbbell className="h-12 w-12 mx-auto" />}
              title="No Active Program"
              description="Select a program to start your fitness journey."
              action={
                <Link to="/programs">
                  <Button variant="primary">See Programs</Button>
                </Link>
              }
            />
          </div>
        </div>
        {isMobile && <TabBar currentPath={location.pathname} />}
      </>
    );
  }

  return (
    <>
      <div className="page-container">
        <div className="px-4 pt-6 pb-24">
          {/* Program Header */}
          <div className="page-header mb-6 px-0">
            <div>
              <h1 className="page-title">{activeProgram.name}</h1>
              <p className="text-base-content/70 mt-1">
                {activeProgram.description}
              </p>
            </div>
          </div>

          {/* Current Workout CTA Card */}
          {currentWorkout && (
            <div>
              <h2 className="text-lg font-semibold text-base-content mb-4 flex items-center gap-2">
                Current Workout
              </h2>

              <div className="program-card mb-8 border-primary">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <h2 className="font-bold text-lg text-base-content mb-1">
                      {currentWorkout.name}
                    </h2>
                    {currentWorkout.description && (
                      <p className="text-sm text-base-content/70 mb-2">
                        {currentWorkout.description}
                      </p>
                    )}
                    <div className="text-sm text-base-content/50">
                      {currentWorkout.exercises.length} exercises
                    </div>
                  </div>
                  <Link to="/workout">
                    <Button variant="primary">
                      {hasTrackedProgress ? "Continue" : "Start"}
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Upcoming Workouts */}
          {upcomingWorkouts.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-base-content mb-4 flex items-center gap-2">
                Upcoming Workouts
              </h2>
              <div className="space-y-3">
                {upcomingWorkouts.map((workout) => {
                  return (
                    <button
                      key={workout.id}
                      className="program-card w-full text-left cursor-pointer hover:border-primary/50 transition-colors"
                      onClick={() => handleWorkoutClick(workout)}
                    >
                      <h3 className="font-bold text-base-content mb-1">
                        {workout.name}
                      </h3>
                      {workout.description && (
                        <p className="text-sm text-base-content/70 mb-2">
                          {workout.description}
                        </p>
                      )}
                      <div className="text-sm text-base-content/50">
                        {workout.exercises.length} exercises
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {isMobile && <TabBar currentPath={location.pathname} />}

      {/* Workout Preview Modal */}
      {activeProgram && (
        <WorkoutPreviewModal
          isOpen={previewWorkout !== null}
          onClose={handleClosePreview}
          workout={previewWorkout}
          programId={activeProgram.id}
          targetWorkoutIndex={previewWorkoutIndex}
          hasTrackedProgress={hasTrackedProgress}
          inProgressSessionId={inProgressSession?.id}
        />
      )}
    </>
  );
}
