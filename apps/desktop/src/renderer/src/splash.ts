// When "Enjoy Every App" (WelcomeSplash in @every-app/desktop-ui) is up: while the window isn't in
// front (it lost focus, or it's hidden), so Mission Control, App Exposé and the Dock's previews
// show it rather than an unreadable shrunken window. It fades out as the window comes back. Not
// during a recording: then the window is the notes beside the call. The hook is in useSplash.ts;
// timings are SPLASH_TIMING, passed in by Root.

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
 * Calls `onChange(true)` once the window has been out of front for `delayMs` (a quick trip to
 * another app or a menu doesn't flash it), and `onChange(false)` as soon as it's back.
 * Answers a function that stops listening.
 */
export function trackAway(target: AwayTarget, delayMs: number, onChange: (away: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let away = false;
  const inFront = () => target.document.visibilityState === "visible" && target.document.hasFocus();
  const update = () => {
    clearTimeout(timer);
    timer = undefined;
    if (inFront()) {
      if (away) onChange((away = false));
    } else if (!away) {
      timer = setTimeout(() => onChange((away = true)), delayMs);
    }
  };
  target.addEventListener("focus", update);
  target.addEventListener("blur", update);
  target.document.addEventListener("visibilitychange", update);
  update();
  return () => {
    clearTimeout(timer);
    target.removeEventListener("focus", update);
    target.removeEventListener("blur", update);
    target.document.removeEventListener("visibilitychange", update);
  };
}
