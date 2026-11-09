// The "Update ready" pill, from main's updater state (AppSnapshot.updater) and
// "update:install" (restarts into the update; during a recording main defers it until Stop).

import type { AppSnapshot, DesktopBridge } from "@shared/ipc";

export type UpdatePill = { version: string; kind: "ready" | "afterStop" } | null;

/**
 * Show the pill once an update is downloaded, never while recording. A restart someone asked for
 * during a recording reads "Restart to update" once it's over. Main clears `deferred` at Stop
 * (it offers the restart again then), so the window remembers it: `wasDeferred`.
 */
export function updatePillOf(state: AppSnapshot | undefined, wasDeferred = false): UpdatePill {
  if (!state || state.recording.state !== "idle") return null;
  const { updater } = state;
  if (updater.state !== "ready" || !updater.version) return null;
  return { version: updater.version, kind: updater.deferred || wasDeferred ? "afterStop" : "ready" };
}

/** Whether a restart was put off for this update: kept until the update is gone or installed. */
export function rememberDeferred(previous: boolean, state: AppSnapshot | undefined): boolean {
  if (!state || state.updater.state !== "ready") return false;
  return previous || state.updater.deferred === true;
}

/** Restart into the update; answers whether main put it off (a recording started meanwhile). */
export function installUpdate(bridge: Pick<DesktopBridge, "update:install">): Promise<{ deferred: boolean }> {
  return bridge["update:install"]();
}
