import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { TabBar } from "@/client/components/TabBar";
import { sessionsCollection, setLogsCollection } from "@/client/tanstack-db";
import { Card, CardTitle } from "@/client/components/ui/card";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { EmptyState } from "@/client/components/ui/empty-state";
import { History, ChevronRight, ChevronDown } from "lucide-react";
import type { WorkoutSession, WorkoutSetLog } from "@/db/schema";

type SessionWithSetLogs = WorkoutSession & {
  setLogs: WorkoutSetLog[];
};

export const Route = createFileRoute("/history")({
  component: HistoryPage,
});

function HistoryPage() {
  const isMobile = useIsMobile();
  const location = useLocation();

  // Live queries
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ session: sessionsCollection }),
  );
  const { data: setLogs } = useLiveQuery((q) =>
    q.from({ setLog: setLogsCollection }),
  );

  // Build sessions with set logs
  const completedSessions = sessions
    ? sessions
        .filter((s) => s.status === "completed")
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        )
        .map((session) => ({
          ...session,
          setLogs: (setLogs ?? [])
            .filter((log) => log.sessionId === session.id)
            .sort((a, b) => a.sortOrder - b.sortOrder),
        }))
    : [];

  if (!completedSessions || completedSessions.length === 0) {
    return (
      <>
        <div className="page-container">
          <div className="px-4 pt-6">
            <EmptyState
              icon={<History className="h-12 w-12 mx-auto" />}
              title="No Workout History"
              description="Complete a workout to see it here."
              action={
                <Link to="/">
                  <Button variant="primary">Start Workout</Button>
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
          {/* Header */}
          <div className="page-header mb-6 px-0">
            <div>
              <h1 className="page-title">History</h1>
              <p className="text-base-content/70 mt-1">
                Your completed workouts
              </p>
            </div>
          </div>

          {/* Session List */}
          <div className="space-y-4">
            {completedSessions.map((session) => (
              <SessionCard key={session.id} session={session} />
            ))}
          </div>
        </div>
      </div>

      {isMobile && <TabBar currentPath={location.pathname} />}
    </>
  );
}

function SessionCard({ session }: { session: SessionWithSetLogs }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const exerciseGroups = groupSetLogsByExercise(session.setLogs);
  const duration =
    session.completedAt && session.startedAt
      ? formatDuration(session.startedAt, session.completedAt)
      : null;

  return (
    <Card className="border border-base-300">
      <div className="card-body p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <CardTitle className="text-lg mb-1">
              {session.workoutNameSnapshot}
            </CardTitle>
            <p className="text-sm opacity-60 mb-2">
              {session.programNameSnapshot}
            </p>
            <div className="flex items-center gap-3 text-xs opacity-50">
              <span>{formatDate(session.startedAt)}</span>
              {duration && (
                <>
                  <span>-</span>
                  <span>{duration}</span>
                </>
              )}
              {session.status === "abandoned" && (
                <Badge variant="warning" className="text-xs">
                  Abandoned
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Expandable Exercise List */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 mt-3 text-sm opacity-70 hover:opacity-100 transition-opacity"
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          {isExpanded ? "Hide details" : "See full workout"}
        </button>

        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-base-300 space-y-2">
            {Array.from(exerciseGroups.entries()).map(
              ([exerciseName, logs], index) => (
                <ExerciseSummary
                  key={`${exerciseName}-${index}`}
                  name={exerciseName}
                  logs={logs}
                />
              ),
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function ExerciseSummary({
  name,
  logs,
}: {
  name: string;
  logs: WorkoutSetLog[];
}) {
  // Sort logs by set number
  const sortedLogs = [...logs].sort((a, b) => a.setNumber - b.setNumber);

  // Build reps string
  const repsDisplay = sortedLogs.map((log) => log.actualReps).join(", ");

  // Get weight if exists
  const weight = sortedLogs[0]?.weight;

  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="font-medium truncate">{name}</span>
      <span className="opacity-60 flex-shrink-0">
        {repsDisplay}
        {weight && <span className="ml-1">@ {weight} lbs</span>}
      </span>
    </div>
  );
}

function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(dateStr));
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const minutes = Math.round(ms / 60000);

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function groupSetLogsByExercise(
  setLogs: WorkoutSetLog[],
): Map<string, WorkoutSetLog[]> {
  const grouped = new Map<string, WorkoutSetLog[]>();

  // Sort by sortOrder to maintain exercise order
  const sorted = [...setLogs].sort((a, b) => a.sortOrder - b.sortOrder);

  sorted.forEach((log) => {
    const existing = grouped.get(log.exerciseNameSnapshot) ?? [];
    grouped.set(log.exerciseNameSnapshot, [...existing, log]);
  });

  return grouped;
}
