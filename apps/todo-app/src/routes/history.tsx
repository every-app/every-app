import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent } from "@/client/components/ui/card";
import { Calendar } from "lucide-react";
import { useIsMobile } from "@/client/hooks/use-mobile";
import { TabBar } from "@/client/components/TabBar";
import { todoCollection } from "@/client/tanstack-db";
import { HistoryItem } from "@/client/components/TodoHistoryItem";

export const Route = createFileRoute("/history")({
  component: History,
});

function History() {
  const isMobile = useIsMobile();

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

  if (isLoading) {
    return null;
  }

  if (isError) {
    return (
      <div className="p-4 overflow-auto">
        <Card className="p-4">
          <CardContent>
            <p className="text-red-600">
              Error: Failed to load completed todos
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="p-4 overflow-auto">
        {completedTodos.length === 0 ? (
          <Card className="p-8 text-center">
            <CardContent>
              <Calendar className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                No completed todos yet
              </h3>
              <p className="text-gray-600 mb-4">
                Complete some todos to see them appear in your history.
              </p>
              <Link to="/">
                <Button>See todos</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {groupedTodos.map((group) => (
              <div key={group.date}>
                <h2 className="text-sm font-medium text-gray-600">
                  {formatDateHeader(group.date)}
                </h2>
                <div className="space-y-2">
                  {group.todos.map((todo) => (
                    <HistoryItem key={todo.id} todo={todo} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {isMobile && (
        <div className="fixed bottom-0 left-0 right-0">
          <TabBar />
        </div>
      )}
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
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    });
  }
}
