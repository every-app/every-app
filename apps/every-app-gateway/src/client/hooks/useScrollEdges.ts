import { useLayoutEffect, useState, type RefObject } from "react";

type ScrollEdges = {
  /** Content is scrolled out of view on the left. */
  before: boolean;
  /** Content is out of view on the right. */
  after: boolean;
};

const NONE: ScrollEdges = { before: false, after: false };

/**
 * What a sideways scroll box hides at each edge, read from its real scroll
 * state: measured on mount, on every scroll, and when the box or its content
 * resizes.
 */
export function useScrollEdges(
  ref: RefObject<HTMLElement | null>,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NONE);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const { scrollLeft, clientWidth, scrollWidth } = element;
      const before = scrollLeft > 1;
      const after = scrollWidth - (scrollLeft + clientWidth) > 1;
      setEdges((prev) =>
        prev.before === before && prev.after === after
          ? prev
          : { before, after },
      );
    };

    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [ref]);

  return edges;
}
