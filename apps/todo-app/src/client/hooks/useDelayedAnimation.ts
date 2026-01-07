import { useState, useEffect } from "react";

/**
 * Hook that enables animations after a delay, allowing the page to load first.
 * This prevents jarring animation effects when items render on initial page load.
 *
 * @param delayMs - Delay in milliseconds before enabling animations (default: 500ms)
 * @returns Whether animations should be enabled
 */
export function useDelayedAnimation(delayMs = 500): boolean {
  const [animationsEnabled, setAnimationsEnabled] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAnimationsEnabled(true);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [delayMs]);

  return animationsEnabled;
}
