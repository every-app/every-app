// The splash's hooks (when it's up: splash.ts). Kept apart so splash.ts tests run without a DOM.

import { useEffect, useState } from "react";
import { trackAway } from "./splash";

export function useWindowAway(delayMs: number): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => trackAway(window, delayMs, setAway), [delayMs]);
  return away;
}

/** The splash after first run: `start` puts it up; it comes down on its own, or at a click or key. */
export function useWelcome(durationMs: number): [boolean, () => void] {
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    if (!welcome) return;
    const end = () => setWelcome(false);
    const timer = setTimeout(end, durationMs);
    window.addEventListener("pointerdown", end, true);
    window.addEventListener("keydown", end, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", end, true);
      window.removeEventListener("keydown", end, true);
    };
  }, [welcome, durationMs]);
  return [welcome, () => setWelcome(true)];
}
