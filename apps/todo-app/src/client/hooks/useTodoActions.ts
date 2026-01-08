import { useCallback, useRef } from "react";
import { todoCollection } from "@/client/tanstack-db";
import { generateSortKeyBetween } from "@/client/lib/fractional-indexing";

interface UseTodoActionsOptions {
  /** Active todos sorted by sortKey descending (highest first) */
  activeTodos: Todo[];
}

interface UseTodoActionsReturn {
  /** Toggle a todo's completed status. When uncompleting, places at bottom of active list. */
  handleToggleComplete: (todoId: string, completed: boolean) => void;
}

/**
 * Hook for common todo actions shared between routes.
 * Handles toggling completion status with proper sortKey management.
 */
export function useTodoActions({
  activeTodos,
}: UseTodoActionsOptions): UseTodoActionsReturn {
  // Use a ref to access activeTodos at call time without recreating the callback
  const activeTodosRef = useRef(activeTodos);
  activeTodosRef.current = activeTodos;

  const handleToggleComplete = useCallback(
    (todoId: string, completed: boolean) => {
      todoCollection.update(todoId, (draft) => {
        draft.completed = completed;
        draft.completedAt = completed ? new Date().toISOString() : null;
        // When uncompleting, always move to bottom of active list
        if (!completed) {
          const currentActiveTodos = activeTodosRef.current;
          if (currentActiveTodos.length > 0) {
            const lowestSortKey =
              currentActiveTodos[currentActiveTodos.length - 1].sortKey;
            draft.sortKey = generateSortKeyBetween(undefined, lowestSortKey);
          } else {
            // No active todos - use a low sort key so it appears at bottom
            // when new todos are added (which get high keys)
            draft.sortKey = "0";
          }
        }
      });
    },
    [],
  );

  return { handleToggleComplete };
}
