import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { useTodos } from "@/client/queries/todos";
import { SortableTodoItem } from "@/client/components/SortableTodoItem";
import { useTodoActions } from "@/client/hooks/useTodoActions";
import {
  getAllActiveTodosBySortKey,
  getUpcomingTodos,
} from "@/client/lib/todo-list-helpers";
import { useKeyboardNavigation } from "@/client/hooks/useKeyboardNavigation";
import { getTodoItemId } from "@/client/lib/element-ids";
import { formatDateKey } from "@/lib/date-key";

export const Route = createFileRoute("/upcoming")({
  component: Upcoming,
});

function Upcoming() {
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);

  const { data: todos, isLoading, isError } = useTodos();

  const todayKey = formatDateKey(new Date());

  const upcomingTodos = useMemo(
    () => getUpcomingTodos(todos, todayKey),
    [todos, todayKey],
  );

  const activeTodos = useMemo(() => getAllActiveTodosBySortKey(todos), [todos]);

  const { handleToggleComplete } = useTodoActions({ activeTodos });

  const upcomingTodoMap = useMemo(() => {
    const map = new Map<string, Todo>();
    for (const todo of upcomingTodos) {
      map.set(todo.id, todo);
    }
    return map;
  }, [upcomingTodos]);

  const handleKeyboardToggle = useCallback(
    (id: string) => {
      const todo = upcomingTodoMap.get(id);
      if (!todo) return;
      handleToggleComplete(id, !todo.completed);
    },
    [handleToggleComplete, upcomingTodoMap],
  );

  useKeyboardNavigation({
    itemIds: upcomingTodos.map((todo) => todo.id),
    getElementId: getTodoItemId,
    onToggle: handleKeyboardToggle,
  });

  if (isLoading) return null;

  if (isError) {
    return (
      <div className="p-4 overflow-auto">
        <p className="text-red-600">Error: Failed to load upcoming todos</p>
      </div>
    );
  }

  return (
    <div className="px-4 pb-24 md:pt-4 md:pb-4 overflow-auto">
      <h1 className="text-xl font-semibold text-base-content py-3 md:hidden">
        Upcoming
      </h1>
      {upcomingTodos.length === 0 ? (
        <div className="flex flex-col items-start gap-3 text-base-content/70">
          <p>No upcoming todos yet.</p>
          <p className="text-sm text-base-content/60">
            Tip: add a due date while typing, like "Pay rent friday".
          </p>
          <Link to="/">
            <Button variant="outline" size="sm">
              Go to todos
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {upcomingTodos.map((todo) => (
            <SortableTodoItem
              key={todo.id}
              todo={todo}
              editingTodoId={editingTodoId}
              setEditingTodoId={setEditingTodoId}
              isDraggable={false}
              onToggleComplete={handleToggleComplete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
