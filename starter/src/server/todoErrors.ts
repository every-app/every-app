/**
 * A todo request the caller can fix (a missing todo, a change that isn't
 * allowed). Its message is written for the user, so agent tools pass it on.
 */
export class TodoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoError";
  }
}
