import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState, useMemo, useCallback } from "react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Plus, ClipboardList } from "lucide-react";
import { CreateTodoModal } from "@/client/components/CreateTodoModal";
import { ConfirmationModal } from "@/client/components/ui/confirmation-modal";
import { AnimatePresence } from "framer-motion";
import {
  AnimatedTodoItem,
  DragStateProvider,
  useDragStateControl,
} from "@/client/components/AnimatedTodoItem";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { todoCollection, insertNewTodo } from "@/client/tanstack-db";
import { generateSortKeyBetween } from "@/client/lib/fractional-indexing";
import { SortableTodoItem } from "@/client/components/SortableTodoItem";
import { useDelayedAnimation } from "@/client/hooks/useDelayedAnimation";
import { useKeyboardNavigation } from "@/client/hooks/useKeyboardNavigation";
import { useTodoActions } from "@/client/hooks/useTodoActions";
import { getTodoItemId, NEW_TODO_INPUT_ID } from "@/client/lib/element-ids";

export const Route = createFileRoute("/")({
  component: Home,
});

/** Completed todos older than this are hidden from the main list */
const COMPLETED_TODOS_VISIBLE_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

function Home() {
  return (
    <DragStateProvider>
      <HomeContent />
    </DragStateProvider>
  );
}

function HomeContent() {
  const { setDragging } = useDragStateControl();
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [newTodoTitle, setNewTodoTitle] = useState<string>("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [deleteModalTodoId, setDeleteModalTodoId] = useState<string | null>(
    null,
  );

  const sensors = useDraggableSensors();

  // Live query that updates automatically when data changes
  const {
    data: todos,
    isLoading,
    isError,
  } = useLiveQuery((q) =>
    q
      .from({ todo: todoCollection })
      .orderBy(({ todo }) => todo.sortKey, "desc"),
  );

  // Derive active and completed todos from query data
  // Sort explicitly to ensure correct order after filtering (descending by sortKey)
  const activeTodos = useMemo(
    () =>
      todos
        ?.filter((todo) => !todo.completed)
        .sort((a, b) =>
          b.sortKey > a.sortKey ? 1 : b.sortKey < a.sortKey ? -1 : 0,
        ) ?? [],
    [todos],
  );

  const completedTodos = useMemo(() => {
    const cutoffTime = Date.now() - COMPLETED_TODOS_VISIBLE_DURATION_MS;
    return (
      todos
        ?.filter((todo) => {
          if (!todo.completed) return false;
          if (!todo.completedAt) return true; // Show if no completedAt timestamp
          const completedTime = new Date(todo.completedAt).getTime();
          return completedTime > cutoffTime;
        })
        // Sort by completedAt ascending (oldest first) so recently completed appear at bottom
        .sort((a, b) => {
          const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
          const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
          return aTime - bTime;
        }) ?? []
    );
  }, [todos]);

  // Enable animations after a delay to avoid jarring effects on page load
  const animationsEnabled = useDelayedAnimation(1000);

  // Use shared hook for todo actions
  const { handleToggleComplete } = useTodoActions({ activeTodos });

  // Get all todo IDs in display order (active + completed)
  const allTodoIds = useMemo(() => {
    const activeIds = activeTodos.map((t) => t.id);
    const completedIds = completedTodos.map((t) => t.id);
    return [...activeIds, ...completedIds];
  }, [activeTodos, completedTodos]);

  // Create a map for quick todo lookup
  const todoMap = useMemo(() => {
    const map = new Map<string, Todo>();
    for (const todo of [...activeTodos, ...completedTodos]) {
      map.set(todo.id, todo);
    }
    return map;
  }, [activeTodos, completedTodos]);

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
    getElementId: getTodoItemId,
    onToggle: handleKeyboardToggle,
    onDelete: handleKeyboardDelete,
  });

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(false);
    const { active, over } = event;

    if (!over || active.id === over.id) return;

    const draggedIndex = activeTodos.findIndex((item) => item.id === active.id);
    const targetIndex = activeTodos.findIndex((item) => item.id === over.id);

    // Only allow drag/drop within active todos
    if (draggedIndex === -1 || targetIndex === -1) return;

    const { beforeTodo, afterTodo } = calculateNewPosition(
      activeTodos,
      draggedIndex,
      targetIndex,
    );

    const newSortKey = generateSortKeyBetween(
      afterTodo?.sortKey,
      beforeTodo?.sortKey,
    );

    todoCollection.update(active.id, (draft) => {
      draft.sortKey = newSortKey;
    });
  };

  if (isLoading) {
    return null;
  }

  if (isError) {
    return (
      <div className="p-4">
        <p className="text-error">Failed to load todos.</p>
      </div>
    );
  }

  return (
    <>
      <div className="px-4 pb-24 md:pt-4 md:pb-0 overflow-y-auto overflow-x-hidden">
        <h1 className="text-xl font-semibold text-base-content py-3 md:hidden">
          Todos
        </h1>
        {/* Desktop: inline form for creating todos */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newTodoTitle.trim()) {
              insertNewTodo(newTodoTitle);
              setNewTodoTitle("");
            }
          }}
          className="hidden md:block space-y-4"
        >
          <div className="flex gap-2">
            <Input
              id={NEW_TODO_INPUT_ID}
              name="title"
              placeholder="New todo... (c)"
              value={newTodoTitle}
              onChange={(e) => setNewTodoTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="focus:border-primary focus:bg-primary/10 transition-colors duration-200"
              aria-label="New todo title"
            />
            <Button
              type="submit"
              disabled={!newTodoTitle.trim()}
              variant="primary"
              aria-label="Add new todo"
            >
              Add
            </Button>
          </div>
        </form>

        {activeTodos.length === 0 && completedTodos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-base-content/50">
            <ClipboardList className="w-16 h-16 mb-4" />
            <p className="text-lg font-medium">No todos yet</p>
            <p className="text-sm md:hidden">Tap + to add your first todo</p>
            <p className="text-sm hidden md:block">
              Type above to add your first todo
            </p>
          </div>
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragStart={() => setDragging(true)}
              onDragCancel={() => setDragging(false)}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={activeTodos.map((todo) => todo.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="md:mt-4 space-y-2">
                  <AnimatePresence mode="sync">
                    {activeTodos.map((todo) => (
                      <AnimatedTodoItem
                        key={todo.id}
                        isAnimationEnabled={animationsEnabled}
                      >
                        <SortableTodoItem
                          todo={todo}
                          editingTodoId={editingTodoId}
                          setEditingTodoId={setEditingTodoId}
                          isDraggable={editingTodoId !== todo.id}
                          onToggleComplete={handleToggleComplete}
                        />
                      </AnimatedTodoItem>
                    ))}
                  </AnimatePresence>
                </div>
              </SortableContext>
            </DndContext>

            {completedTodos.length > 0 && (
              <div className="border-base-300 mt-4">
                <div className="space-y-2 opacity-75">
                  <AnimatePresence mode="sync">
                    {completedTodos.map((todo) => (
                      <AnimatedTodoItem
                        key={todo.id}
                        isAnimationEnabled={animationsEnabled}
                      >
                        <SortableTodoItem
                          todo={todo}
                          editingTodoId={editingTodoId}
                          setEditingTodoId={setEditingTodoId}
                          isDraggable={false}
                          onToggleComplete={handleToggleComplete}
                        />
                      </AnimatedTodoItem>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Mobile: FAB for creating todos */}
      {!editingTodoId && (
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="md:hidden fixed bottom-24 right-4 z-40 w-14 h-14 bg-primary text-primary-content rounded-xl flex items-center justify-center shadow-lg border border-base-content/10"
          aria-label="Add new todo"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}

      <CreateTodoModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />

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

function calculateNewPosition(
  activeTodos: Todo[],
  draggedIndex: number,
  targetIndex: number,
): { beforeTodo?: Todo; afterTodo?: Todo } {
  const isMovingDown = draggedIndex < targetIndex;

  if (isMovingDown) {
    // Moving down in UI = moving to higher index = want to appear after targetIndex
    // Need a sort key between target and the item below it (target+1)
    return {
      beforeTodo: activeTodos[targetIndex], // Higher sort key
      afterTodo: activeTodos[targetIndex + 1], // Lower sort key
    };
  } else {
    // Moving up in UI = moving to lower index = want to appear before targetIndex
    // Need a sort key between the item above target (target-1) and target
    return {
      beforeTodo: activeTodos[targetIndex - 1], // Higher sort key
      afterTodo: activeTodos[targetIndex], // Lower sort key
    };
  }
}

/**
 * Configure drag-and-drop sensors for todo list reordering.
 *
 * We use separate MouseSensor and TouchSensor (not PointerSensor) because they require
 * different activation strategies:
 *
 * - MouseSensor (desktop): Uses distance-based activation (8px movement required).
 *   This allows clicks on interactive elements (checkbox, edit button) to work normally
 *   since clicks don't involve movement. Drag only initiates after intentional movement.
 *
 * - TouchSensor (mobile): Uses delay-based activation (150ms hold required).
 *   Distance-based doesn't work well on touch because normal scrolling/tapping
 *   easily exceeds any reasonable distance threshold. The delay allows taps to
 *   register as clicks while a press-and-hold initiates drag.
 *
 * - KeyboardSensor: Enables keyboard-based reordering for accessibility.
 *   Users can focus a todo item, press Space/Enter to start dragging,
 *   use arrow keys to move, and press Space/Enter again to drop.
 *   Press Escape to cancel the drag operation.
 *
 * Note: PointerSensor handles both mouse and touch, but we can't use it here because
 * we need different activation constraints for each input type.
 */
function useDraggableSensors() {
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 150,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  return sensors;
}

/**
 * Modifier that restricts drag movement to vertical axis only.
 * Prevents horizontal dragging which can cause items to overflow the container.
 */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
