/**
 * Centralized element ID definitions.
 * Use these functions to ensure consistent IDs across the app for keyboard navigation.
 */

/** ID for the new todo input field */
export const NEW_TODO_INPUT_ID = "new-todo-input";

/** Generate ID for a todo item container (used for focus management) */
export function getTodoItemId(id: string): string {
  return `todo-item-${id}`;
}

/** Generate ID for a history item container (used for focus management) */
export function getHistoryItemId(id: string): string {
  return `history-item-${id}`;
}

/** Generate ID for a todo's inline edit textarea */
export function getTodoInlineEditId(id: string): string {
  return `todo-inline-edit-${id}`;
}
