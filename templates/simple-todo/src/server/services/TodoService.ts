import { TodoRepository } from "../repositories/TodoRepository";
import type {
  CreateTodoInput,
  UpdateTodoInput,
  DeleteTodoInput,
} from "@/types/schemas/todos";

/**
 * Get all todos for a user.
 */
async function getAll(userId: string) {
  const todos = await TodoRepository.findAllByUserId(userId);
  return { todos };
}

/**
 * Create a todo.
 */
async function create(userId: string, data: CreateTodoInput) {
  await TodoRepository.create({
    id: data.id,
    userId,
    title: data.title,
  });

  return { success: true };
}

/**
 * Update a todo.
 * Validates ownership and business rules before updating.
 */
async function update(userId: string, data: UpdateTodoInput) {
  const existingTodo = await TodoRepository.findByIdAndUserId(data.id, userId);

  if (!existingTodo) {
    throw new Error("Todo not found");
  }

  // Validate: Cannot edit title of completed todos
  if (
    existingTodo.completed &&
    data.title !== undefined &&
    data.title !== existingTodo.title
  ) {
    throw new Error(
      "Cannot edit the title of a completed todo. Unmark it as completed first.",
    );
  }

  // Prepare update data
  const updateData = {
    title: data.title ?? existingTodo.title,
    completed: data.completed ?? existingTodo.completed,
  };

  await TodoRepository.update(data.id, userId, updateData);
  return { success: true };
}

/**
 * Delete a todo.
 * Validates ownership before deleting.
 */
async function deleteTodo(userId: string, data: DeleteTodoInput) {
  const existingTodo = await TodoRepository.findByIdAndUserId(data.id, userId);

  if (!existingTodo) {
    throw new Error("Todo not found");
  }

  await TodoRepository.delete(data.id, userId);
  return { success: true };
}

export const TodoService = {
  getAll,
  create,
  update,
  delete: deleteTodo,
} as const;
