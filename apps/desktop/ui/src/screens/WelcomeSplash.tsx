import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import { EveryAppMark } from "./OnboardingScreen";

/** How long the fades last, in ms, and how long the one after first run stays up. */
export const SPLASH_TIMING = {
  fadeIn: 450,
  fadeOut: 300,
  /** After first run: up this long (fade-in included), then it fades out. */
  welcome: 1800,
  /** The window has to stay out of front this long before the splash comes up. */
  awayDelay: 300,
} as const;

export interface WelcomeSplashProps {
  /** Up or not. It fades between the two; the renderer decides when (`splash.ts`). */
  shown: boolean;
  /** Called once it has faded out completely. */
  onHidden?: () => void;
  /** No fades; defaults to `prefers-reduced-motion`. */
  reducedMotion?: boolean;
  /** Fill the nearest positioned ancestor rather than the window (the playground). */
  contained?: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * "Enjoy Every App": the window dims and a large mark with the line fades in over it. Sized to
 * read when macOS shrinks the window (Mission Control, App Exposé). It never takes input: clicks
 * go through to the app.
 */
export function WelcomeSplash({
  shown,
  onHidden,
  reducedMotion,
  contained = false,
}: WelcomeSplashProps) {
  const [still] = useState(() => reducedMotion ?? prefersReducedMotion());
  // Mount hidden and show on the next frames, so the fade-in runs from the first paint.
  const [up, setUp] = useState(still && shown);
  // Painted at all: through the fade-out, then hidden so the blur costs nothing.
  const [present, setPresent] = useState(shown);
  const wasPresent = useRef(shown);
  const hidden = useRef(onHidden);
  hidden.current = onHidden;

  useEffect(() => {
    if (shown) {
      setPresent(true);
      wasPresent.current = true;
      if (still) {
        setUp(true);
        return;
      }
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setUp(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setUp(false);
    if (!wasPresent.current) return;
    // A timer rather than transitionend, so it always reports.
    const timer = setTimeout(
      () => {
        setPresent(false);
        wasPresent.current = false;
        hidden.current?.();
      },
      still ? 0 : SPLASH_TIMING.fadeOut,
    );
    return () => clearTimeout(timer);
  }, [shown, still]);

  const duration = still
    ? "0ms"
    : `${up ? SPLASH_TIMING.fadeIn : SPLASH_TIMING.fadeOut}ms`;

  return (
    <div
      data-shown={up}
      aria-hidden={!up}
      className={cn(
        "pointer-events-none inset-0 z-50 flex items-center justify-center",
        contained ? "absolute" : "fixed",
      )}
      style={{ visibility: present ? "visible" : "hidden" }}
    >
      {/* The window behind, dimmed: dark in both themes, so the mark and line read white. */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[3px] transition-opacity ease-out dark:bg-black/60"
        style={{ opacity: up ? 1 : 0, transitionDuration: duration }}
      />
      <div
        role="status"
        aria-live="polite"
        className="relative flex flex-col items-center gap-6 transition-[opacity,transform] ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{
          opacity: up ? 1 : 0,
          transform: still || up ? "none" : "scale(0.96)",
          transitionDuration: duration,
        }}
      >
        <EveryAppMark
          tone="light"
          className="size-24 drop-shadow-[0_10px_30px_rgb(0_0_0/0.35)]"
        />
        <p className="text-[44px] font-semibold leading-none tracking-[-0.02em] text-white [text-shadow:0_2px_16px_rgb(0_0_0/0.35)]">
          Enjoy Every App
        </p>
      </div>
    </div>
  );
}
