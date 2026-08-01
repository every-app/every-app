import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTodos } from "@/client/queries/todos";
import { HistoryItem } from "@/client/components/TodoHistoryItem";

export const Route = createFileRoute("/history")({
  component: History,
});

function History() {
  const { data: todos, isLoading, isError } = useTodos();

  const completedTodos = useMemo(
    () => todos?.filter((todo) => todo.completed) ?? [],
    [todos],
  );

  if (isLoading) {
    return null;
  }

  if (isError) {
    return (
      <div className="p-4 overflow-auto">
        <p className="text-error">Error: Failed to load completed todos</p>
      </div>
    );
  }

  return (
    <>
      <div className="px-4 pb-4 md:pt-4 overflow-auto">
        <h1 className="text-xl font-semibold text-base-content py-3">
          History
        </h1>
        {completedTodos.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-base-content/70">No completed todos yet</p>
            <Link to="/">
              <button className="btn btn-primary btn-sm">Go to todos</button>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {completedTodos.map((todo) => (
              <HistoryItem key={todo.id} todo={todo} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
