// When a press on the floating recorder's pill becomes a drag. Pure, for the tests.

/** How far (px) the pointer travels with the button down before a click becomes a drag. */
export const DRAG_THRESHOLD = 4;

/** Whether the pointer, pressed at `from`, has moved far enough to `to` to be dragging. */
export function isDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;
}
