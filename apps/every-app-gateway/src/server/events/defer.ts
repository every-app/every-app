/**
 * Run event work after the response. The emit points on request paths
 * (the app lists, the perimeter's setup gate, a tool call's audit) must
 * not wait on the bus, so they hand it to `waitUntil`; where no request
 * context exists (a unit test that mocks `cloudflare:workers` with its
 * env alone) the work still runs, and a failure is swallowed either way:
 * an event is never allowed to break what caused it.
 */
import * as workers from "cloudflare:workers";

type WaitUntil = (task: Promise<unknown>) => void;

function waitUntilOrNull(): WaitUntil | null {
  try {
    const candidate = (workers as { waitUntil?: unknown }).waitUntil;
    return typeof candidate === "function" ? (candidate as WaitUntil) : null;
  } catch {
    // A mocked module without the export throws on access.
    return null;
  }
}

export function deferEventWork(task: () => Promise<void>): void {
  const run = task().catch(() => undefined);
  waitUntilOrNull()?.(run);
}
