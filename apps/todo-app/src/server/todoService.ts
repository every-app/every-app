import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { todos, users } from "@/db/schema";
import type {
  CreateTodoInput,
  DeleteTodoInput,
  UpdateTodoInput,
} from "@/types/schemas/todos";

interface TodoUser {
  id: string;
  email: string;
}

interface TodoResult {
  id: string;
  title: string;
  completed: boolean;
}

export const TodoService = {
  async list(userId: string) {
    return db
      .select({
        id: schema.todos.id,
        title: schema.todos.title,
        completed: schema.todos.completed,
        completedAt: schema.todos.completedAt,
        sortKey: schema.todos.sortKey,
        dueDate: schema.todos.dueDate,
      })
      .from(schema.todos)
      .where(eq(todos.userId, userId));
  },

  async create(user: TodoUser, input: CreateTodoInput): Promise<TodoResult> {
    await db
      .insert(users)
      .values({ id: user.id, email: user.email })
      .onConflictDoNothing();
    await db.insert(todos).values({
      id: input.id,
      userId: user.id,
      title: input.title,
      sortKey: input.sortKey,
      dueDate: input.dueDate ?? null,
    });

    return { id: input.id, title: input.title, completed: false };
  },

  async update(userId: string, input: UpdateTodoInput): Promise<TodoResult> {
    const existing = await db.query.todos.findFirst({
      where: and(eq(todos.id, input.id), eq(todos.userId, userId)),
    });
    if (!existing) throw new Error("Todo not found");

    if (
      existing.completed &&
      input.title !== undefined &&
      input.title !== existing.title
    ) {
      throw new Error(
        "Cannot edit the title of a completed todo. Unmark it as completed first.",
      );
    }

    const updateData: Partial<typeof todos.$inferInsert> = {};
    if (input.title !== undefined) updateData.title = input.title;
    if (input.sortKey !== undefined) updateData.sortKey = input.sortKey;
    if (input.dueDate !== undefined) updateData.dueDate = input.dueDate;
    if (input.completed !== undefined) {
      updateData.completed = input.completed;
      if (input.completed && !existing.completed) {
        updateData.completedAt = new Date().toISOString();
      } else if (!input.completed && existing.completed) {
        updateData.completedAt = null;
      }
    }

    if (Object.keys(updateData).length > 0) {
      await db
        .update(todos)
        .set(updateData)
        .where(and(eq(todos.id, input.id), eq(todos.userId, userId)));
    }

    return {
      id: input.id,
      title: input.title ?? existing.title,
      completed: input.completed ?? existing.completed,
    };
  },

  async delete(userId: string, input: DeleteTodoInput): Promise<TodoResult> {
    const existing = await db.query.todos.findFirst({
      where: and(eq(todos.id, input.id), eq(todos.userId, userId)),
      columns: { id: true, title: true, completed: true },
    });
    if (!existing) throw new Error("Todo not found");

    await db
      .delete(todos)
      .where(and(eq(todos.id, input.id), eq(todos.userId, userId)));
    return existing;
  },
};
