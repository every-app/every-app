import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { useActiveProgram } from "@/client/hooks/useProgramData";
import { sessionsCollection } from "@/client/tanstack-db";
import { TabBar } from "@/client/components/TabBar";
import { Button } from "@/client/components/ui/button";
import { EmptyState } from "@/client/components/ui/empty-state";
import { Dumbbell } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const isMobile = useIsMobile();
  const location = useLocation();

  const { activeProgram } = useActiveProgram();

  // Live query for sessions to check if workout has been started
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ session: sessionsCollection }),
  );

  // Current workout and upcoming workouts
  const currentWorkout =
    activeProgram && activeProgram.workouts.length > 0
      ? activeProgram.workouts[activeProgram.currentWorkoutIndex]
      : null;

  // Check if current workout has an in-progress session
  const hasInProgressSession = currentWorkout
    ? (sessions?.some(
        (s) => s.workoutId === currentWorkout.id && s.status === "in_progress",
      ) ?? false)
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
                      {hasInProgressSession ? "Continue" : "Start"}
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
                {upcomingWorkouts.map((workout, index) => {
                  return (
                    <div key={workout.id} className="program-card">
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
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {isMobile && <TabBar currentPath={location.pathname} />}
    </>
  );
}
