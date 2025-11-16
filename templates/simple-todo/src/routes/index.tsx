import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState, useMemo } from "react";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { MobileTodoInput } from "@/client/components/MobileTodoInput";
import { TabBar } from "@/client/components/TabBar";
import { todoCollection } from "@/client/tanstack-db";
import { TodoItem } from "@/client/components/TodoItem";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [newTodoTitle, setNewTodoTitle] = useState<string>("");

  // Live query that updates automatically when data changes
  const {
    data: todos,
    isLoading,
    isError,
  } = useLiveQuery((q) => q.from({ todo: todoCollection }));

  // Derive active and completed todos from query data
  const activeTodos = useMemo(
    () => todos?.filter((todo) => !todo.completed) ?? [],
    [todos],
  );

  if (isLoading) {
    return null;
  }

  if (isError) {
    return (
      <div className="p-4">
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h2 className="text-lg font-semibold mb-2">Error</h2>
          <p>Todo live query error.</p>
        </div>
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
                  completed: false,
                });
                setNewTodoTitle("");
              }
            }}
            className="space-y-4"
          >
            <div className="flex gap-2">
              <input
                type="text"
                name="title"
                placeholder="New todo..."
                value={newTodoTitle}
                onChange={(e) => setNewTodoTitle(e.target.value)}
                autoFocus
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:border-blue-500 focus:bg-blue-50 focus:ring-2 focus:ring-blue-200 focus:outline-none transition-all duration-200"
                aria-label="New todo title"
              />
              <button
                type="submit"
                disabled={!newTodoTitle.trim()}
                className="px-4 py-2 bg-black text-white rounded-md hover:bg-gray-700 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed focus:ring-2 focus:ring-black focus:ring-offset-2 focus:outline-none transition-all duration-200"
                aria-label="Add new todo"
              >
                Add
              </button>
            </div>
          </form>
        )}

        <div className={isMobile ? "space-y-2" : "sm:mt-4 space-y-2"}>
          {activeTodos.map((todo) => (
            <TodoItem
              key={todo.id}
              todo={todo}
              editingTodoId={editingTodoId}
              setEditingTodoId={setEditingTodoId}
            />
          ))}
        </div>
      </div>

      {isMobile && (
        <div className="fixed bottom-0 left-0 right-0">
          <MobileTodoInput />
          <TabBar currentPath={location.pathname} />
        </div>
      )}
    </>
  );
}
