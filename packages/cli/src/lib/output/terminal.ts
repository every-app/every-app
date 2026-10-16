/**
 * At a terminal the human sink keeps a line open while milestones join it,
 * with a spinner at its end. A prompt, or a child attached to the terminal
 * (`cf deploy` asking its own questions, `cf auth login`), would be drawn
 * over: before either, the line is ended and the spinner stopped.
 */
const drawing = new Set<() => void>();

/** Called by whatever draws on the terminal; returns how to stop being called. */
export function onTerminalHandoff(release: () => void): () => void {
  drawing.add(release);
  return () => drawing.delete(release);
}

/** End the open line and stop the spinner: a prompt or an attached child comes next. */
export function handTerminalOver(): void {
  for (const release of drawing) release();
}

/** Whether stdout is a terminal a spinner can redraw. */
export function isTerminal(): boolean {
  return (
    Boolean(process.stdout.isTTY) &&
    process.env["TERM"] !== "dumb" &&
    !process.env["CI"]
  );
}
