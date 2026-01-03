import { db } from "@/db";
import { todos } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// Types for repository operations
type CreateTodo = {
  id: string;
  userId: string;
  title: string;
};

type UpdateTodo = {
  title?: string;
  completed?: boolean;
};

/**
 * Find all todos for a user.
 */
async function findAllByUserId(userId: string) {
  return db.query.todos.findMany({
    where: eq(todos.userId, userId),
    columns: {
      id: true,
      title: true,
      completed: true,
    },
  });
}

/**
 * Find a todo by ID and user ID.
 */
async function findByIdAndUserId(id: string, userId: string) {
  return db.query.todos.findFirst({
    where: and(eq(todos.id, id), eq(todos.userId, userId)),
  });
}

/**
 * Create a todo.
 */
async function create(data: CreateTodo) {
  await db.insert(todos).values({
    id: data.id,
    userId: data.userId,
    title: data.title,
  });
}

/**
 * Update a todo.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function update(id: string, userId: string, data: UpdateTodo) {
  await db
    .update(todos)
    .set(data)
    .where(and(eq(todos.id, id), eq(todos.userId, userId)));
}

/**
 * Delete a todo.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function deleteById(id: string, userId: string) {
  await db.delete(todos).where(and(eq(todos.id, id), eq(todos.userId, userId)));
}

export const TodoRepository = {
  findAllByUserId,
  findByIdAndUserId,
  create,
  update,
  delete: deleteById,
} as const;
