/**
 * At a terminal the human sink redraws its last line: the spinner of the
 * step running, with the cursor hidden. A prompt, or a child attached to the
 * terminal (`cf deploy` asking its own questions, `cf auth login`), would be
 * drawn over: before either, the spinner is stopped and the cursor shown.
 */
const drawing = new Set<() => void>();

/** Called by whatever draws on the terminal; returns how to stop being called. */
export function onTerminalHandoff(release: () => void): () => void {
  drawing.add(release);
  return () => drawing.delete(release);
}

/** Stop the spinner and show the cursor: a prompt or an attached child comes next. */
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
