import { useState, useRef, useEffect, useCallback } from "react";

interface Position {
  top: number;
  left: number;
}

interface UseDelayedHoverOptions {
  /** Delay in milliseconds before showing the hover state (default: 400) */
  delay?: number;
}

interface UseDelayedHoverReturn<T> {
  /** The currently hovered item identifier, or null if nothing is hovered */
  hoveredItem: T | null;
  /** Position for positioning a tooltip near the hovered element */
  tooltipPosition: Position;
  /** Call this on mouseEnter with the item identifier and the element's bounding rect */
  onMouseEnter: (item: T, rect: DOMRect) => void;
  /** Call this on mouseLeave */
  onMouseLeave: () => void;
}

const DEFAULT_DELAY = 400;

/**
 * Hook for managing delayed hover state with tooltip positioning.
 * Shows hover state only after user hovers for a specified delay,
 * preventing flickering when quickly moving across items.
 */
export function useDelayedHover<T>(
  options: UseDelayedHoverOptions = {},
): UseDelayedHoverReturn<T> {
  const { delay = DEFAULT_DELAY } = options;

  const [hoveredItem, setHoveredItem] = useState<T | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<Position>({
    top: 0,
    left: 0,
  });
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timeout on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  const onMouseEnter = useCallback(
    (item: T, rect: DOMRect) => {
      setTooltipPosition({
        top: rect.top + rect.height / 2,
        left: rect.right + 8,
      });
      hoverTimeoutRef.current = setTimeout(() => {
        setHoveredItem(item);
      }, delay);
    },
    [delay],
  );

  const onMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHoveredItem(null);
  }, []);

  return {
    hoveredItem,
    tooltipPosition,
    onMouseEnter,
    onMouseLeave,
  };
}
