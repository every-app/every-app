import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useCallback, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/client/components/ui/button";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { todoCollection } from "@/client/tanstack-db";
import { HistoryItem } from "@/client/components/TodoHistoryItem";
import { AnimatedTodoItem } from "@/client/components/AnimatedTodoItem";
import { useDelayedAnimation } from "@/client/hooks/useDelayedAnimation";
import { useKeyboardNavigation } from "@/client/hooks/useKeyboardNavigation";
import { useTodoActions } from "@/client/hooks/useTodoActions";
import { getHistoryItemId } from "@/client/lib/element-ids";

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

  // Get active todos for sortKey calculation when un-completing
  const activeTodos = useMemo(
    () =>
      todos
        ?.filter((todo) => !todo.completed)
        .sort((a, b) =>
          b.sortKey > a.sortKey ? 1 : b.sortKey < a.sortKey ? -1 : 0,
        ) ?? [],
    [todos],
  );

  const groupedTodos = useMemo(
    () => groupTodosByDate(completedTodos),
    [completedTodos],
  );

  // Get all todo IDs in display order (flattened from grouped todos)
  const allTodoIds = useMemo(() => {
    return groupedTodos.flatMap((group) => group.todos.map((t) => t.id));
  }, [groupedTodos]);

  // Enable animations after a delay to avoid jarring effects on page load
  const animationsEnabled = useDelayedAnimation(1000);

  const [deleteModalTodoId, setDeleteModalTodoId] = useState<string | null>(
    null,
  );

  // Use shared hook for todo actions
  const { handleToggleComplete } = useTodoActions({ activeTodos });

  // Create a map for quick todo lookup
  const todoMap = useMemo(() => {
    const map = new Map<string, Todo>();
    for (const todo of completedTodos) {
      map.set(todo.id, todo);
    }
    return map;
  }, [completedTodos]);

  // Handle toggle from keyboard navigation
  const handleKeyboardToggle = useCallback(
    (id: string) => {
      const todo = todoMap.get(id);
      if (todo) {
        handleToggleComplete(id, !todo.completed);
      }
    },
    [todoMap, handleToggleComplete],
  );

  // Handle delete from keyboard navigation (opens modal)
  const handleKeyboardDelete = useCallback((id: string) => {
    setDeleteModalTodoId(id);
  }, []);

  // Use the keyboard navigation hook
  useKeyboardNavigation({
    itemIds: allTodoIds,
    getElementId: getHistoryItemId,
    onToggle: handleKeyboardToggle,
    onDelete: handleKeyboardDelete,
  });

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
      <div className="flex h-full min-h-0 flex-col">
        <h1 className="shrink-0 bg-base-200 px-4 py-3 text-xl font-semibold text-base-content md:hidden">
          History
        </h1>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 md:pt-4">
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
                  <h2 className="text-sm font-medium text-gray-600 mb-2">
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
      </div>

      <ConfirmationModal
        isOpen={deleteModalTodoId !== null}
        onClose={() => setDeleteModalTodoId(null)}
        onConfirm={() => {
          if (deleteModalTodoId) {
            todoCollection.delete(deleteModalTodoId);
            setDeleteModalTodoId(null);
          }
        }}
        title="Delete Todo"
        description="Are you sure you want to delete this todo? This action cannot be undone."
        confirmText="Delete"
        variant="danger"
      />
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
