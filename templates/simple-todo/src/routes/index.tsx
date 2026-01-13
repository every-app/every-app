import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Plus, Info } from "lucide-react";
import { CreateTodoModal } from "@/client/components/CreateTodoModal";
import { todoCollection } from "@/client/tanstack-db";
import { TodoItem } from "@/client/components/TodoItem";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [newTodoTitle, setNewTodoTitle] = useState<string>("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

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
        <p className="text-error">Todo live query error.</p>
      </div>
    );
  }

  return (
    <>
      <div className="px-4 pb-24 md:pt-4 md:pb-0 overflow-auto">
        <h1 className="text-xl font-semibold text-base-content py-3 md:hidden">
          Todos
        </h1>

        {/* Template starter alert */}
        <div className="alert alert-info mb-4">
          <Info className="w-5 h-5" />
          <div>
            <span className="font-medium">This the starter template.</span>{" "}
            <a
              href="https://everyapp.dev/docs/build-an-app/create-app/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:opacity-80"
            >
              See the docs
            </a>{" "}
            to see an example prompt for building an app and what features are
            available to you.
          </div>
        </div>

        {/* Desktop: inline form for creating todos */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newTodoTitle.trim()) {
              todoCollection.insert({
                id: crypto.randomUUID(),
                title: newTodoTitle.trim(),
                completed: false,
              });
              toast("Todo created");
              setNewTodoTitle("");
            }
          }}
          className="hidden md:block space-y-4"
        >
          <div className="flex gap-2">
            <input
              type="text"
              name="title"
              placeholder="New todo..."
              value={newTodoTitle}
              onChange={(e) => setNewTodoTitle(e.target.value)}
              autoFocus
              className="input flex-1"
              aria-label="New todo title"
            />
            <button
              type="submit"
              disabled={!newTodoTitle.trim()}
              className="btn btn-primary"
              aria-label="Add new todo"
            >
              Add
            </button>
          </div>
        </form>

        <div className="md:mt-4 space-y-2">
          {activeTodos.map((todo) => (
            <TodoItem key={todo.id} todo={todo} />
          ))}
        </div>
      </div>

      {/* Mobile: FAB for creating todos */}
      <button
        onClick={() => setIsCreateModalOpen(true)}
        className="md:hidden fixed bottom-24 right-4 z-40 w-14 h-14 bg-primary text-primary-content rounded-xl flex items-center justify-center shadow-lg border border-base-content/10"
        aria-label="Add new todo"
      >
        <Plus className="w-6 h-6" />
      </button>

      <CreateTodoModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </>
  );
}
