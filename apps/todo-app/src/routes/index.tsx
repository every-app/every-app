import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState, useMemo } from "react";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { MobileTodoInput } from "@/client/components/MobileTodoInput";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { TabBar } from "@/client/components/TabBar";
import { todoCollection } from "@/client/tanstack-db";
import {
  generateDefaultSortKey,
  generateSortKeyBetween,
} from "@/client/lib/fractional-indexing";
import { SortableTodoItem } from "@/client/components/SortableTodoItem";

export const Route = createFileRoute("/")({
  component: Home,
});

/** Completed todos older than this are hidden from the main list */
const COMPLETED_TODOS_VISIBLE_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

function Home() {
  const isMobile = useIsMobile();
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [newTodoTitle, setNewTodoTitle] = useState<string>("");

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
  const activeTodos = useMemo(
    () => todos?.filter((todo) => !todo.completed) ?? [],
    [todos],
  );

  const completedTodos = useMemo(() => {
    const cutoffTime = Date.now() - COMPLETED_TODOS_VISIBLE_DURATION_MS;
    return (
      todos?.filter((todo) => {
        if (!todo.completed) return false;
        if (!todo.completedAt) return true; // Show if no completedAt timestamp
        const completedTime = new Date(todo.completedAt).getTime();
        return completedTime > cutoffTime;
      }) ?? []
    );
  }, [todos]);

  const handleDragEnd = (event: DragEndEvent) => {
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
        <Card className="p-2">
          <CardHeader>
            <CardTitle>Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p>Todo live query error.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="px-4 pb-16 md:pt-4 md:pb-0 overflow-auto">
        {!isMobile && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newTodoTitle.trim()) {
                todoCollection.insert({
                  id: crypto.randomUUID(),
                  title: newTodoTitle.trim(),
                  sortKey: generateDefaultSortKey(),
                  completed: false,
                  completedAt: null,
                });
                setNewTodoTitle("");
              }
            }}
            className="space-y-4"
          >
            <div className="flex gap-2">
              <Input
                name="title"
                placeholder="New todo..."
                value={newTodoTitle}
                onChange={(e) => setNewTodoTitle(e.target.value)}
                autoFocus
                className="focus:border-blue-500 focus:bg-blue-50 focus:ring-2 focus:ring-blue-200 transition-all duration-200"
                aria-label="New todo title"
              />
              <Button
                type="submit"
                disabled={!newTodoTitle.trim()}
                className="bg-black text-white hover:bg-gray-700 hover:shadow-lg disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:outline-none transition-all duration-200 transform hover:scale-[1.02]"
                aria-label="Add new todo"
              >
                Add
              </Button>
            </div>
          </form>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={activeTodos.map((todo) => todo.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className={isMobile ? "space-y-2" : "sm:mt-4 space-y-2"}>
              {activeTodos.map((todo) => (
                <SortableTodoItem
                  key={todo.id}
                  todo={todo}
                  editingTodoId={editingTodoId}
                  setEditingTodoId={setEditingTodoId}
                  isDraggable={editingTodoId !== todo.id}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {completedTodos.length > 0 && (
          <div
            className={isMobile ? "border-gray-200 mt-4" : "border-gray-200"}
          >
            <div className="space-y-2 opacity-75">
              {completedTodos.map((todo) => (
                <SortableTodoItem
                  key={todo.id}
                  todo={todo}
                  editingTodoId={editingTodoId}
                  setEditingTodoId={setEditingTodoId}
                  isDraggable={false}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {isMobile && (
        <div className="fixed bottom-0 left-0 right-0">
          <MobileTodoInput />
          <TabBar />
        </div>
      )}
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
      keyboardCodes: {
        start: [],
        cancel: [],
        end: [],
      },
    }),
  );
  return sensors;
}
