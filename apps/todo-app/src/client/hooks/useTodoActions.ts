import { useCallback, useRef } from "react";
import { useTodoMutations } from "@/client/queries/todos";
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
  const { update } = useTodoMutations();
  // Use a ref to access activeTodos at call time without recreating the callback
  const activeTodosRef = useRef(activeTodos);
  activeTodosRef.current = activeTodos;

  const handleToggleComplete = useCallback(
    (todoId: string, completed: boolean) => {
      let sortKey: string | undefined;

      // When uncompleting, always move to bottom of active list
      if (!completed) {
        const currentActiveTodos = activeTodosRef.current;
        if (currentActiveTodos.length > 0) {
          const lowestSortKey =
            currentActiveTodos[currentActiveTodos.length - 1].sortKey;
          sortKey = generateSortKeyBetween(undefined, lowestSortKey);
        } else {
          // No active todos - use a low sort key so it appears at bottom
          // when new todos are added (which get high keys)
          sortKey = "0";
        }
      }

      update.mutate({ id: todoId, completed, sortKey });
    },
    [update],
  );

  return { handleToggleComplete };
}
