// When "Enjoy Every App" (WelcomeSplash in @every-app/desktop-ui) is up: only while the window is
// out of sight (minimized, hidden, or fully covered: the page's visibilityState is "hidden"), and
// only once it has been in front in this run. Never over a window the person can see: one that
// opens without focus, or sits unfocused beside another app, shows its content. It fades out as
// the window comes back. Not during a recording. The hook is in useSplash.ts; timings are
// SPLASH_TIMING, passed in by Root.

import type { AppSnapshot } from "@shared/ipc";

export interface SplashInputs {
  away: boolean;
  recording: AppSnapshot["recording"]["state"];
}

export function splashShownOf({ away, recording }: SplashInputs): boolean {
  return away && recording === "idle";
}

/** The bits of `window` trackAway listens to. */
export interface AwayTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  document: {
    hasFocus(): boolean;
    readonly visibilityState: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
}

/**
 * Calls `onChange(true)` once the window has been out of sight for `delayMs`, and
 * `onChange(false)` as soon as it's visible again. Out of sight is the page being hidden
 * (minimized, hidden, fully covered); losing focus isn't. Nothing is reported until the window has
 * been in front (visible and focused) once, so a window that opens unfocused or hidden never
 * starts away. Answers a function that stops listening.
 */
export function trackAway(target: AwayTarget, delayMs: number, onChange: (away: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let away = false;
  let beenInFront = false;
  const update = () => {
    clearTimeout(timer);
    timer = undefined;
    const visible = target.document.visibilityState === "visible";
    if (visible && target.document.hasFocus()) beenInFront = true;
    if (visible) {
      if (away) onChange((away = false));
    } else if (beenInFront && !away) {
      timer = setTimeout(() => onChange((away = true)), delayMs);
    }
  };
  target.addEventListener("focus", update);
  target.document.addEventListener("visibilitychange", update);
  update();
  return () => {
    clearTimeout(timer);
    target.removeEventListener("focus", update);
    target.document.removeEventListener("visibilitychange", update);
  };
}
