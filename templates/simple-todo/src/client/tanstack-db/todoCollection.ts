import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  createTodo,
  deleteTodo,
  getAllTodos,
  updateTodo,
} from "@/serverFunctions/todos";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/cloudflare";

export const todoCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["todos"],
      queryFn: async () => {
        const todos = await getAllTodos();
        return todos.todos;
      },
      queryClient,
      getKey: (item) => item.id,
      // Handle all CRUD operations
      onInsert: async ({ transaction }) => {
        const { modified: newTodo } = transaction.mutations[0];
        await createTodo({
          data: newTodo,
        });
      },
      onUpdate: async ({ transaction }) => {
        const { modified } = transaction.mutations[0];
        await updateTodo({
          data: modified,
        });
      },
      onDelete: async ({ transaction }) => {
        const { original } = transaction.mutations[0];
        await deleteTodo({ data: original });
      },
    }),
  ),
);
