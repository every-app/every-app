import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { todos } from "@/db/schema";

export const createTodoInput = z
  .object({ title: z.string().trim().min(1, "Title is required").max(255) })
  .strict();
export const updateTodoInput = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1, "Title is required").max(255).optional(),
    completed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (change) => change.title !== undefined || change.completed !== undefined,
    "Give a title or completed",
  );
export const deleteTodoInput = z.object({ id: z.string().uuid() }).strict();

interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

const shown = { id: todos.id, title: todos.title, completed: todos.completed };

// Every query is scoped by the Gateway's user id. The Gateway admits every
// member of the organization; which rows each one sees is the app's job.
export function listTodos(userId: string): Promise<Todo[]> {
  return db
    .select(shown)
    .from(todos)
    .where(eq(todos.userId, userId))
    .orderBy(todos.createdAt, todos.id);
}

export async function createTodo(
  userId: string,
  input: z.infer<typeof createTodoInput>,
): Promise<Todo> {
  const [todo] = await db
    .insert(todos)
    .values({ id: crypto.randomUUID(), userId, title: input.title })
    .returning(shown);
  return todo!;
}

/** The changed todo, or null when no todo of this user has the id. */
export async function updateTodo(
  userId: string,
  { id, ...change }: z.infer<typeof updateTodoInput>,
): Promise<Todo | null> {
  const [todo] = await db
    .update(todos)
    .set(change)
    .where(and(eq(todos.id, id), eq(todos.userId, userId)))
    .returning(shown);
  return todo ?? null;
}

/** The deleted todo, or null when no todo of this user has the id. */
export async function deleteTodo(
  userId: string,
  { id }: z.infer<typeof deleteTodoInput>,
): Promise<Todo | null> {
  const [todo] = await db
    .delete(todos)
    .where(and(eq(todos.id, id), eq(todos.userId, userId)))
    .returning(shown);
  return todo ?? null;
}
