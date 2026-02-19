const sortBySortKeyDesc = (a: Todo, b: Todo) =>
  b.sortKey > a.sortKey ? 1 : b.sortKey < a.sortKey ? -1 : 0;

export function getHomeActiveTodos(
  todos: Todo[] | undefined,
  todayKey: string,
) {
  return (
    todos
      ?.filter(
        (todo) =>
          !todo.completed && (!todo.dueDate || todo.dueDate <= todayKey),
      )
      .sort(sortBySortKeyDesc) ?? []
  );
}

export function getRecentCompletedTodos(
  todos: Todo[] | undefined,
  visibleDurationMs: number,
) {
  const cutoffTime = Date.now() - visibleDurationMs;
  return (
    todos
      ?.filter((todo) => {
        if (!todo.completed) return false;
        if (!todo.completedAt) return true;
        const completedTime = new Date(todo.completedAt).getTime();
        return completedTime > cutoffTime;
      })
      .sort((a, b) => {
        const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return aTime - bTime;
      }) ?? []
  );
}

export function getUpcomingTodos(todos: Todo[] | undefined, todayKey: string) {
  return (
    todos
      ?.filter(
        (todo) => !todo.completed && !!todo.dueDate && todo.dueDate >= todayKey,
      )
      .sort((a, b) => {
        if (a.dueDate === b.dueDate) {
          return sortBySortKeyDesc(a, b);
        }
        return a.dueDate! < b.dueDate! ? -1 : 1;
      }) ?? []
  );
}

export function getAllActiveTodosBySortKey(todos: Todo[] | undefined) {
  return todos?.filter((todo) => !todo.completed).sort(sortBySortKeyDesc) ?? [];
}
