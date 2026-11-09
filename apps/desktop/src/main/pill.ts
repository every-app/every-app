// The floating recorder's rules, apart from Electron (pillWindow.ts) so they can be tested: when
// it shows, where it sits, and when hovering opens and closes its transcript panel.

import type { Rect, RecordingSnapshot } from "@shared/ipc";

/** Shown from Start until the stop has finished (`stopping` included), if the setting is on. */
export function shouldShowPill(state: RecordingSnapshot["state"], enabled: boolean): boolean {
  return enabled && (state === "starting" || state === "recording" || state === "stopping");
}

/** Sizes in points, read off Granola's Retina screenshots (Ben's reference): a 34×60 capsule, and
 * a 292×342 panel to its left whose bottom sits `LIFT` lower than the pill's. */
export const PILL = { width: 34, height: 60 } as const;
export const PANEL = { width: 292, height: 342, minWidth: 220, minHeight: 200 } as const;
/** Room around the drawing inside the window (so the border isn't clipped), the gap between the
 * panel and the pill, the panel's distance from the work area's right and bottom edges (the
 * pill's right edge is MARGIN in, too), and how far the pill sits above the panel's bottom. */
export const INSET = 4;
export const GAP = 5;
export const MARGIN = 8;
export const LIFT = 32;

export interface PillLayout {
  /** The window, in screen coordinates. */
  window: Rect;
  /** In window coordinates. */
  panel: Rect;
  pill: Rect;
}

/**
 * The window covers the panel and the pill (to the panel's right, a little above its bottom), in
 * the bottom-right corner of the work area. The panel shrinks to fit a small display.
 */
export function pillLayout(workArea: Rect): PillLayout {
  const room = (n: number) => Math.max(0, Math.floor(n));
  const panelWidth = Math.max(PANEL.minWidth, Math.min(PANEL.width, room(workArea.width - 2 * MARGIN - PILL.width - GAP - 2 * INSET)));
  const panelHeight = Math.max(PANEL.minHeight, Math.min(PANEL.height, room(workArea.height - 2 * MARGIN - 2 * INSET)));
  const width = INSET + panelWidth + GAP + PILL.width + INSET;
  const height = INSET + panelHeight + INSET;
  // The pill's right edge and the panel's bottom sit MARGIN in from the work area's edges.
  const right = workArea.x + workArea.width - MARGIN + INSET;
  const bottom = workArea.y + workArea.height - MARGIN + INSET;
  return {
    window: { x: right - width, y: bottom - height, width, height },
    panel: { x: INSET, y: INSET, width: panelWidth, height: panelHeight },
    pill: { x: INSET + panelWidth + GAP, y: INSET + panelHeight - LIFT - PILL.height, width: PILL.width, height: PILL.height },
  };
}

export type Zone = "pill" | "panel" | null;

const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** What the cursor (screen coordinates) is over. The gap between the panel and the pill counts
 * as the panel, so crossing it doesn't close anything. */
export function zoneAt(cursor: { x: number; y: number }, layout: PillLayout): Zone {
  const local = { x: cursor.x - layout.window.x, y: cursor.y - layout.window.y };
  if (inside(local, layout.pill)) return "pill";
  const { panel } = layout;
  if (inside(local, { ...panel, width: panel.width + GAP })) return "panel";
  return null;
}

/**
 * Opens the panel after the cursor rests on the pill for `openMs` (passing over it does nothing),
 * keeps it open while the cursor is over the pill or the panel, and closes it once the cursor has
 * been off both for `closeMs`.
 */
export class HoverTracker {
  private expanded = false;
  private since: number | undefined;

  constructor(
    private readonly openMs = 150,
    private readonly closeMs = 400,
  ) {}

  get isExpanded(): boolean {
    return this.expanded;
  }

  /** The cursor's zone at `now` (ms); answers whether the panel is open. */
  update(zone: Zone, now: number): boolean {
    if (!this.expanded) {
      if (zone !== "pill") this.since = undefined;
      else if (this.since === undefined) this.since = now;
      if (this.since !== undefined && now - this.since >= this.openMs) {
        this.expanded = true;
        this.since = undefined;
      }
    } else {
      if (zone !== null) this.since = undefined;
      else if (this.since === undefined) this.since = now;
      if (this.since !== undefined && now - this.since >= this.closeMs) {
        this.expanded = false;
        this.since = undefined;
      }
    }
    return this.expanded;
  }

  reset(): void {
    this.expanded = false;
    this.since = undefined;
  }
}

/** Whether the window should take the mouse at all: only over the pill, or the open panel.
 * Everywhere else clicks go through to the app underneath. */
export function takesMouse(zone: Zone, expanded: boolean): boolean {
  return zone === "pill" || (expanded && zone === "panel");
}
