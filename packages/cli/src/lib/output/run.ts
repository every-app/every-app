import { setExitCode } from "@/lib/exit-code";
import { createHumanSink, createNdjsonSink, type EventSink } from "./events";
import { reportFailure } from "./report";
import { isTerminal } from "./terminal";

/**
 * NDJSON events on stdout with --json, and nothing else there; lines for a
 * person otherwise (more of them with --verbose).
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
  { verbose = false }: { verbose?: boolean } = {},
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (verbose && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    reportFailure(out, error);
  }
  setExitCode(out.exitCode);
}
