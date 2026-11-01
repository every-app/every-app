import { useLayoutEffect, useState, type RefObject } from "react";

type ScrollOverflow = {
  /** Content is scrolled out of view above. */
  canScrollUp: boolean;
  /** Content is out of view below. */
  canScrollDown: boolean;
  /** How many rows (`rowSelector` matches) sit mostly below the fold. */
  hiddenBelow: number;
};

const NONE: ScrollOverflow = {
  canScrollUp: false,
  canScrollDown: false,
  hiddenBelow: 0,
};

/**
 * What a scroll box hides, read from its real scroll state: measured on
 * mount, on every scroll, when the box or its content resizes, and again
 * when `deps` change (the rows rendered into it). Rows are counted from
 * their `offsetTop`, so the box must be positioned (`relative`).
 */
export function useScrollOverflow(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[] = [],
  rowSelector = "li",
): ScrollOverflow {
  const [overflow, setOverflow] = useState<ScrollOverflow>(NONE);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      setOverflow(NONE);
      return;
    }

    const measure = () => {
      const { scrollTop, clientHeight, scrollHeight } = element;
      const fold = scrollTop + clientHeight;
      const canScrollDown = scrollHeight - fold > 1;
      let hiddenBelow = 0;
      if (canScrollDown) {
        for (const row of element.querySelectorAll<HTMLElement>(rowSelector)) {
          if (row.offsetTop + row.offsetHeight / 2 > fold) hiddenBelow += 1;
        }
      }
      const next = { canScrollUp: scrollTop > 1, canScrollDown, hiddenBelow };
      setOverflow((prev) =>
        prev.canScrollUp === next.canScrollUp &&
        prev.canScrollDown === next.canScrollDown &&
        prev.hiddenBelow === next.hiddenBelow
          ? prev
          : next,
      );
    };

    measure();
    element.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    // The content: rows come and go while the box stays at its max height.
    for (const child of element.children) observer?.observe(child);

    return () => {
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [ref, rowSelector, ...deps]);

  return overflow;
}
