// React hooks over the preload bridge. Screens use these (and TanStack Query for /api/v1 data),
// never `window.everyapp` directly, so the bridge can be mocked in renderer tests.

import { useSyncExternalStore } from "react";
import type { AppSnapshot } from "@shared/ipc";
import { applyHelperEvent } from "./live";

export const bridge = window.everyapp;

// One subscription for the whole window: the app snapshot and the helper's live events.
let snapshot: AppSnapshot | undefined;
const listeners = new Set<() => void>();
let started = false;

function setSnapshot(next: AppSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

/** Start listening to main; call once at startup. `onNavigate` gets main's page requests. */
export function connectBridge(onNavigate: (request: unknown) => void): void {
  if (started) return;
  started = true;
  void bridge["state:get"]().then(setSnapshot);
  bridge.on("state", setSnapshot);
  bridge.on("helper", applyHelperEvent);
  // Main's app menu (Settings…, ⌘,) and the tray ask for a page.
  bridge.on("navigate", onNavigate);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The latest snapshot, outside React. */
export const currentSnapshot = (): AppSnapshot | undefined => snapshot;

export function useAppState(): AppSnapshot | undefined {
  return useSyncExternalStore(subscribe, () => snapshot);
}
