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

export function useTodos() {
  return useQuery({
    queryKey: todosKey,
    queryFn: async () => (await getAllTodos()).todos,
  });
}

export function useTodoMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: todosKey });

  return {
    create: useMutation({
      mutationFn: (data: CreateTodoInput) => createTodo({ data }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (data: UpdateTodoInput) => updateTodo({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: DeleteTodoInput) => deleteTodo({ data }),
      onSuccess: invalidate,
    }),
  };
}
