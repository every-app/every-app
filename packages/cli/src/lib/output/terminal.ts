/**
 * What everyapp's output can do where it runs.
 *
 *  | Situation                  | Spinner   | Colors    | Prompts |
 *  |----------------------------|-----------|-----------|---------|
 *  | a terminal                 | yes       | yes       | yes     |
 *  | stdout piped, stdin a TTY  | no        | no        | yes (drawn on stderr) |
 *  | stdin not a terminal       | as stdout | as stdout | no      |
 *  | CI=1                       | no        | yes       | no      |
 *  | TERM=dumb                  | no        | no        | yes     |
 *  | NO_COLOR=1 or --no-color   | yes       | no        | yes     |
 *
 * Prompts (./prompt.ts) decide with `canPromptInTerminal`; the human sink
 * spins with `isTerminal`; bin/cli.ts sets chalk's level once, from
 * `colorEnabled`, before anything is drawn.
 */

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

/**
 * Whether everyapp colors what it prints (its own lines, stricli's help
 * and errors, prompts): never with NO_COLOR or `--no-color`, and only when
 * stdout is a terminal that isn't dumb.
 */
export function colorEnabled(
  noColorFlag: boolean,
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTerminal = Boolean(process.stdout.isTTY),
): boolean {
  return !noColorFlag && !env["NO_COLOR"] && stdoutIsTerminal && env["TERM"] !== "dumb";
}
