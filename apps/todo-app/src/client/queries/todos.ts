import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTodo,
  deleteTodo,
  getAllTodos,
  updateTodo,
} from "@/serverFunctions/todos";
import type {
  CreateTodoInput,
  DeleteTodoInput,
  UpdateTodoInput,
} from "@/types/schemas/todos";

export const todosKey = ["todos"] as const;
export const todosMutationKey = ["todos", "mutation"] as const;

export function useTodos() {
  return useQuery({
    queryKey: todosKey,
    queryFn: async () => (await getAllTodos()).todos,
  });
}

export function useTodoMutations() {
  const queryClient = useQueryClient();
  const cancelTodosRefetch = () =>
    queryClient.cancelQueries({ queryKey: todosKey });
  const reconcileWithServer = () => {
    // Avoid letting an earlier mutation's refetch overwrite a later optimistic
    // update. The last pending todo mutation performs the reconciliation.
    if (
      queryClient.isMutating({ mutationKey: todosMutationKey, exact: true }) ===
      1
    ) {
      return queryClient.invalidateQueries({ queryKey: todosKey });
    }
  };

  return {
    create: useMutation({
      mutationKey: todosMutationKey,
      mutationFn: (data: CreateTodoInput) => createTodo({ data }),
      onMutate: async (newTodo) => {
        await cancelTodosRefetch();

        const previousTodos = queryClient.getQueryData<Todo[]>(todosKey);
        queryClient.setQueryData<Todo[]>(todosKey, (todos = []) => [
          ...todos,
          {
            ...newTodo,
            completed: false,
            completedAt: null,
            dueDate: newTodo.dueDate ?? null,
          },
        ]);

        return { previousTodos };
      },
      onError: (_error, _newTodo, context) => {
        queryClient.setQueryData(todosKey, context?.previousTodos);
      },
      onSettled: reconcileWithServer,
    }),
    update: useMutation({
      mutationKey: todosMutationKey,
      mutationFn: (data: UpdateTodoInput) => updateTodo({ data }),
      onMutate: async (update) => {
        await cancelTodosRefetch();

        const previousTodos = queryClient.getQueryData<Todo[]>(todosKey);
        queryClient.setQueryData<Todo[]>(todosKey, (todos = []) =>
          todos.map((todo) => {
            if (todo.id !== update.id) return todo;

            return {
              ...todo,
              ...(update.title !== undefined && { title: update.title }),
              ...(update.completed !== undefined && {
                completed: update.completed,
                completedAt: update.completed ? new Date().toISOString() : null,
              }),
              ...(update.sortKey !== undefined && {
                sortKey: update.sortKey,
              }),
              ...(update.dueDate !== undefined && {
                dueDate: update.dueDate,
              }),
            };
          }),
        );

        return { previousTodos };
      },
      onError: (_error, _update, context) => {
        queryClient.setQueryData(todosKey, context?.previousTodos);
      },
      onSettled: reconcileWithServer,
    }),
    remove: useMutation({
      mutationKey: todosMutationKey,
      mutationFn: (data: DeleteTodoInput) => deleteTodo({ data }),
      onMutate: async ({ id }) => {
        await cancelTodosRefetch();

        const previousTodos = queryClient.getQueryData<Todo[]>(todosKey);
        queryClient.setQueryData<Todo[]>(todosKey, (todos = []) =>
          todos.filter((todo) => todo.id !== id),
        );

        return { previousTodos };
      },
      onError: (_error, _deletedTodo, context) => {
        queryClient.setQueryData(todosKey, context?.previousTodos);
      },
      onSettled: reconcileWithServer,
    }),
  };
}
