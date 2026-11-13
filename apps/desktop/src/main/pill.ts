// The floating recorder's rules, apart from Electron (pillWindow.ts) so they can be tested: when
// it shows, where it sits (the corner, or where it was dragged to), and when hovering opens and
// closes its transcript panel.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Rect, RecordingSnapshot } from "@shared/ipc";

/** What main knows about its own window (window.ts), for `mainWindowInFront`. */
export interface MainWindowFacts {
  /** The window exists and isn't hidden (closing it hides it). */
  visible: boolean;
  minimized: boolean;
  /** It's the key window: Every App is the active app and this is the window being typed in. */
  focused: boolean;
}

/**
 * The main window is in front: on screen and the one in use. Its recorder bar is then the
 * indicator. Not when another app is frontmost, the window is minimised, hidden or closed, or
 * you're on another Space (something else has the focus there).
 */
export function mainWindowInFront(w: MainWindowFacts | undefined): boolean {
  return !!w && w.visible && !w.minimized && w.focused;
}

/**
 * Shown from Start until the stop has finished (`stopping` included), if the setting is on and
 * the main window isn't in front: one indicator at a time.
 */
export function shouldShowPill(state: RecordingSnapshot["state"], enabled: boolean, mainInFront: boolean): boolean {
  return enabled && !mainInFront && (state === "starting" || state === "recording" || state === "stopping");
}

/** How long the main window must have been out of front before the pill comes back, so a moment
 * without focus (a sheet, a menu, ⌘-Tab and straight back) doesn't blink it. Hiding is immediate. */
export const PILL_RETURN_MS = 250;

/** Sizes in points, read off Granola's Retina screenshots (Ben's reference): a 34×60 capsule, and
 * a 292×342 panel beside it whose bottom sits `LIFT` lower than the pill's. */
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
  /** Which side of the pill the panel opens on: away from the screen edge the pill is at. */
  panelSide: "left" | "right";
}

/** Where someone dragged the pill to on one display: the screen edge it snapped to, and how far
 * down that edge it sits (0 at the top of its travel, 1 at the bottom). A fraction, so it stays
 * on screen when the resolution or the Dock changes. */
export interface PillPosition {
  edge: "left" | "right";
  y: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));

/** Where the pill's top-left corner may be (screen coordinates): MARGIN inside the work area. */
function pillRange(workArea: Rect): { minX: number; maxX: number; minY: number; maxY: number } {
  const minX = workArea.x + MARGIN;
  const minY = workArea.y + MARGIN;
  return {
    minX,
    maxX: Math.max(minX, workArea.x + workArea.width - MARGIN - PILL.width),
    minY,
    maxY: Math.max(minY, workArea.y + workArea.height - MARGIN - PILL.height),
  };
}

/** The pill's top-left corner while it's dragged: wherever the cursor takes it, inside the work area. */
export function clampPill(point: { x: number; y: number }, workArea: Rect): { x: number; y: number } {
  const r = pillRange(workArea);
  return { x: Math.round(clamp(point.x, r.minX, r.maxX)), y: Math.round(clamp(point.y, r.minY, r.maxY)) };
}

/** Where a pill let go at `point` (its top-left corner, screen coordinates) settles: on the
 * nearer of the left and right edges, at the height it was dropped. */
export function snapPill(point: { x: number; y: number }, workArea: Rect): PillPosition {
  const r = pillRange(workArea);
  const centre = point.x + PILL.width / 2;
  const span = r.maxY - r.minY;
  return {
    edge: centre < workArea.x + workArea.width / 2 ? "left" : "right",
    y: span > 0 ? (clamp(point.y, r.minY, r.maxY) - r.minY) / span : 1,
  };
}

/**
 * The window covers the panel and the pill. Without a `position` the pill is in the bottom-right
 * corner of the work area, a little above the panel's bottom; dragged, it sits on the left or
 * right edge at the height it was left. The panel opens on the pill's inner side, its bottom
 * LIFT below the pill's unless that would leave the work area, and shrinks to fit a small display.
 */
export function pillLayout(workArea: Rect, position?: PillPosition): PillLayout {
  const room = (n: number) => Math.max(0, Math.floor(n));
  const panelWidth = Math.max(PANEL.minWidth, Math.min(PANEL.width, room(workArea.width - 2 * MARGIN - PILL.width - GAP - 2 * INSET)));
  const panelHeight = Math.max(PANEL.minHeight, Math.min(PANEL.height, room(workArea.height - 2 * MARGIN - 2 * INSET)));
  const r = pillRange(workArea);
  const bottom = workArea.y + workArea.height - MARGIN;
  const pillX = position?.edge === "left" ? r.minX : r.maxX;
  const pillY = position
    ? Math.round(r.minY + clamp(position.y, 0, 1) * (r.maxY - r.minY))
    : clamp(bottom - LIFT - PILL.height, r.minY, r.maxY);
  const panelSide = position?.edge === "left" ? "right" : "left";
  const panelX = panelSide === "left" ? pillX - GAP - panelWidth : pillX + PILL.width + GAP;
  // On a display shorter than the panel, the panel keeps to the bottom, as it always has.
  const panelY = Math.min(Math.max(pillY + PILL.height + LIFT - panelHeight, workArea.y + MARGIN), bottom - panelHeight);
  const x = Math.min(pillX, panelX) - INSET;
  const y = Math.min(pillY, panelY) - INSET;
  return {
    window: {
      x,
      y,
      width: Math.max(pillX + PILL.width, panelX + panelWidth) + INSET - x,
      height: Math.max(pillY + PILL.height, panelY + panelHeight) + INSET - y,
    },
    panel: { x: panelX - x, y: panelY - y, width: panelWidth, height: panelHeight },
    pill: { x: pillX - x, y: pillY - y, width: PILL.width, height: PILL.height },
    panelSide,
  };
}

/** What's remembered between recordings (userData/recorder-position.json): where the pill was
 * left on each display it has been dragged on, and the display it was last dragged on. */
export interface PillPlaces {
  /** The display's id (Electron's `Display.id`). */
  last?: string;
  displays: Record<string, PillPosition>;
}

const MAX_REMEMBERED_DISPLAYS = 16;

/** Reads the stored file leniently: keeps each valid entry, drops the rest. */
export function readPillPlaces(value: unknown): PillPlaces {
  const places: PillPlaces = { displays: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return places;
  const o = value as Record<string, unknown>;
  const displays = o.displays && typeof o.displays === "object" && !Array.isArray(o.displays) ? Object.entries(o.displays) : [];
  for (const [id, v] of displays.slice(0, MAX_REMEMBERED_DISPLAYS)) {
    const p = v as Partial<PillPosition> | null;
    if (!p || typeof p !== "object" || !/^-?\d{1,20}$/.test(id)) continue;
    if ((p.edge !== "left" && p.edge !== "right") || typeof p.y !== "number" || !(p.y >= 0 && p.y <= 1)) continue;
    places.displays[id] = { edge: p.edge, y: p.y };
  }
  if (typeof o.last === "string" && Object.hasOwn(places.displays, o.last)) places.last = o.last;
  return places;
}

/** `places` with the pill left at `position` on `display`, which becomes the last one. The
 * oldest entries go once there are more displays than anyone has. */
export function withPillPlace(places: PillPlaces, display: string, position: PillPosition): PillPlaces {
  const others = Object.entries(places.displays).filter(([id]) => id !== display);
  return { last: display, displays: Object.fromEntries([...others.slice(-(MAX_REMEMBERED_DISPLAYS - 1)), [display, position]]) };
}

/** The remembered places, as JSON in userData/recorder-position.json. */
export class PillPlacesStore {
  private current: PillPlaces = { displays: {} };

  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    try {
      this.current = readPillPlaces(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`floating recorder: position unreadable, back to the corner (${String(error)})`);
    }
  }

  get value(): PillPlaces {
    return this.current;
  }

  set(places: PillPlaces): void {
    this.current = places;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(places, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      this.log(`floating recorder: couldn't save its position (${String(error)})`);
    }
  }
}

/** Where the recorder opens: on the display it was last dragged on, if that one is connected,
 * else on `fallback` (the display under the cursor); at the spot remembered for that display. */
export function pillPlaceFor(places: PillPlaces, connected: readonly string[], fallback: string): { display: string; position?: PillPosition } {
  const display = places.last !== undefined && connected.includes(places.last) ? places.last : fallback;
  return { display, position: places.displays[display] };
}

export type Zone = "pill" | "panel" | null;

const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** What the cursor (screen coordinates) is over. The gap between the panel and the pill counts
 * as the panel, so crossing it doesn't close anything. */
export function zoneAt(cursor: { x: number; y: number }, layout: PillLayout): Zone {
  const local = { x: cursor.x - layout.window.x, y: cursor.y - layout.window.y };
  if (inside(local, layout.pill)) return "pill";
  const { panel } = layout;
  const withGap = { ...panel, x: layout.panelSide === "left" ? panel.x : panel.x - GAP, width: panel.width + GAP };
  if (inside(local, withGap)) return "panel";
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
