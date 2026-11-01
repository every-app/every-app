import { useEffect, useState } from "react";

/** How long the page must be visible and focused before Allow can arm. */
export const ALLOW_ARM_DELAY_MS = 600;

/**
 * Whether Allow may be pressed: once this page has been visible and focused
 * for a moment, and the user has done something on it since: moved the
 * pointer, pressed a key, or touched the screen (a tap moves no pointer
 * first, so on a phone the tap that lands on Allow arms it). A click aimed
 * at another window just as this one appears (double-click jacking, which
 * no framing protection stops) meets a disabled button: it comes too soon,
 * and a mouse press, unlike a touch, never arms Allow by itself. Leaving
 * the page disarms it again.
 */
export function useDeliberateAllow(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      clearTimeout(timer);
      ready = false;
      setArmed(false);
    };
    const start = () => {
      disarm();
      if (document.visibilityState !== "visible" || !document.hasFocus()) {
        return;
      }
      timer = setTimeout(() => {
        ready = true;
      }, ALLOW_ARM_DELAY_MS);
    };
    const interact = () => {
      if (ready) setArmed(true);
    };
    const press = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") interact();
    };
    const visibility = () =>
      document.visibilityState === "visible" ? start() : disarm();
    start();
    window.addEventListener("focus", start);
    window.addEventListener("blur", disarm);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pointermove", interact);
    window.addEventListener("keydown", interact);
    // Capturing, so a tap arms Allow before the button sees it.
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("touchstart", interact, {
      capture: true,
      passive: true,
    });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", disarm);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pointermove", interact);
      window.removeEventListener("keydown", interact);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("touchstart", interact, true);
    };
  }, []);
  return armed;
}
