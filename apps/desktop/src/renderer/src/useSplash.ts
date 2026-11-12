// The splash's hooks (when it's up: splash.ts). Kept apart so splash.ts tests run without a DOM.

import { useEffect, useState } from "react";
import { trackAway } from "./splash";

export function useWindowAway(delayMs: number): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => trackAway(window, delayMs, setAway), [delayMs]);
  return away;
}
