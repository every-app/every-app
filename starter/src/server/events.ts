import { emit } from "@every-app/sdk/server";

interface EmitScope {
  env: object;
  /** The inbound request: its user becomes the event's actor. */
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Tell the workspace's subscribers a todo was marked done (Manage
 * workspace, Events: `app.<your app id>.todo.completed`). The UI and the
 * update_todo tool both call it, so a todo an AI client ticks goes out too.
 * The id only: titles are each person's own. Under waitUntil, so an emit
 * that fails never fails the change.
 */
export function emitIfCompleted(
  { env, request, waitUntil }: EmitScope,
  change: { completed?: boolean },
  todo: { id: string } | null,
): void {
  if (!todo || !change.completed) return;
  waitUntil(
    emit({
      env,
      for: request,
      event: "todo.completed",
      data: { todoId: todo.id },
    }),
  );
}
