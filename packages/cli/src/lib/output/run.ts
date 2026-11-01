import { setExitCode } from "@/lib/exit-code";
import { createHumanSink, createNdjsonSink, type EventSink } from "./events";
import { reportFailure } from "./report";
import { isTerminal } from "./terminal";

/**
 * NDJSON events on stdout with --json, and nothing else there; lines for a
 * person otherwise (more of them with --verbose, and an unexpected error's
 * stack).
 */
export function eventSink(json?: boolean, verbose?: boolean): EventSink {
  return json
    ? createNdjsonSink()
    : createHumanSink({ verbose, terminal: isTerminal() });
}

/**
 * Run a command, reporting a failure as its last event; the exit code is
 * 0, 2 (an action is required; run the command again after it) or 1.
 */
export async function runReported(
  out: EventSink,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    reportFailure(out, error);
  }
  setExitCode(out.exitCode);
}

/** A command's run: its sink from --json and --verbose, its failure reported. */
export async function runCommand(
  flags: { json?: boolean; verbose?: boolean },
  body: (out: EventSink) => Promise<void>,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(out, () => body(out));
}
