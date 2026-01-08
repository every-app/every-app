import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/client/components/ui/button";
import { todoCollection } from "@/client/tanstack-db";
import { HistoryItem } from "@/client/components/TodoHistoryItem";
import { AnimatedTodoItem } from "@/client/components/AnimatedTodoItem";
import { useDelayedAnimation } from "@/client/hooks/useDelayedAnimation";

export const Route = createFileRoute("/history")({
  component: History,
});

function History() {
  // Live query that updates automatically when data changes
  const {
    data: todos,
    isLoading,
    isError,
  } = useLiveQuery((q) =>
    q.from({ todo: todoCollection }).orderBy(({ todo }) => todo.sortKey, "asc"),
  );

  const completedTodos = useMemo(
    () => todos?.filter((todo) => todo.completed) ?? [],
    [todos],
  );

  const groupedTodos = useMemo(
    () => groupTodosByDate(completedTodos),
    [completedTodos],
  );

  // Enable animations after a delay to avoid jarring effects on page load
  const animationsEnabled = useDelayedAnimation(1000);

  // Callback to toggle a todo's completed status
  const handleToggleComplete = useCallback(
    (todoId: string, completed: boolean) => {
      todoCollection.update(todoId, (draft) => {
        draft.completed = completed;
        draft.completedAt = completed ? new Date().toISOString() : null;
      });
    },
    [],
  );

  if (isLoading) {
    return null;
  }

  if (isError) {
    return (
      <div className="p-4 overflow-auto">
        <p className="text-red-600">Error: Failed to load completed todos</p>
      </div>
    );
  }

  return (
    <>
      <div className="px-4 pb-4 md:pt-4 overflow-auto">
        <h1 className="text-xl font-semibold text-base-content py-3 md:hidden">
          History
        </h1>
        {completedTodos.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p>No completed todos yet</p>
            <Link to="/">
              <Button variant="outline" size="sm">
                Go to todos
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {groupedTodos.map((group) => (
              <div key={group.date}>
                <h2 className="text-sm font-medium text-gray-600">
                  {formatDateHeader(group.date)}
                </h2>
                <div className="space-y-2">
                  <AnimatePresence mode="sync">
                    {group.todos.map((todo) => (
                      <AnimatedTodoItem
                        key={todo.id}
                        isAnimationEnabled={animationsEnabled}
                      >
                        <HistoryItem
                          todo={todo}
                          onToggleComplete={handleToggleComplete}
                        />
                      </AnimatedTodoItem>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function groupTodosByDate(
  todos: Todo[],
): Array<{ date: string; todos: Todo[] }> {
  const groups = new Map<string, Todo[]>();

  todos.forEach((todo) => {
    const completedAt = todo.completedAt;
    if (!completedAt) return;

    const date = new Date(completedAt);
    const dateKey = date.toDateString();

    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(todo);
  });

  return Array.from(groups.entries())
    .map(([date, todos]) => ({ date, todos }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function formatDateHeader(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return "Today";
  } else if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  } else {
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    });
  }
}
