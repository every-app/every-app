import { emit } from "@every-app/sdk/server";

interface EmitScope {
  env: object;
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Tell the workspace's subscribers a todo was marked done (Manage
 * workspace, Events: `app.<your app id>.todo.completed`). The UI and the
 * update_todo tool both call it, so a todo an AI client ticks goes out too.
 * The id only: titles are each person's own. Under waitUntil, so an emit
 * that fails never fails the change. No `for`: the event is the request's
 * (its user becomes the actor), which everyApp() keeps in the request
 * context for the UI's server function and the tool call alike.
 */
export function emitIfCompleted(
  { env, waitUntil }: EmitScope,
  change: { completed?: boolean },
  todo: { id: string } | null,
): void {
  if (!todo || !change.completed) return;
  waitUntil(
    emit({
      env,
      event: "todo.completed",
      data: { todoId: todo.id },
    }),
  );
}
