// The floating recorder: a small pill in the bottom-right corner of the screen while recording,
// over every app (full-screen ones too) and on every Space. It never takes focus from the meeting
// app. Resting the mouse on it opens the live transcript beside it; clicking it opens the
// meeting in Every App's window; dragging it moves it along the screen's left and right edges,
// and it stays where it was left. The rules (when, where, hover) are in pill.ts.
//
// The window always covers the panel's area as well, so opening the panel needs no resize; it
// ignores the mouse (clicks go through) except over the pill or the open panel. Hover is read by
// polling the cursor, which works the same whether or not Every App is the active app.
//
// A drag starts in the page (the pointer went down on the pill and moved) and is carried out
// here: the window follows the cursor until the page says the button came up. The window isn't
// `movable` and has no drag region, which would swallow the click and need the window to be key.

import { BrowserWindow, screen, type Display } from "electron";
import { join } from "node:path";
import type { PillView, RecordingSnapshot } from "@shared/ipc";
import type { HelperEvent } from "@shared/protocol";
import type { LiveTranscriptBuffer } from "./liveTranscript";
import { clampPill, HoverTracker, pillLayout, pillPlaceFor, snapPill, takesMouse, withPillPlace, zoneAt, type PillLayout, type PillPlacesStore } from "./pill";

const POLL_MS = 50;
const TRANSCRIPT_PUSH_MS = 100;
const DRAG_MS = 16;

export interface PillWindowOptions {
  preloadPath: string;
  /** The dev server (unpackaged runs), else the bundled page is loaded. */
  devUrl?: string;
  recording: () => RecordingSnapshot;
  transcript: LiveTranscriptBuffer;
  /** Where the pill was dragged to, per display. */
  places: PillPlacesStore;
  log: (line: string) => void;
}

export class RecorderPillWindow {
  private window: BrowserWindow | undefined;
  private layout: PillLayout | undefined;
  private readonly hover = new HoverTracker();
  private poll: NodeJS.Timeout | undefined;
  private mouse = false;
  private transcriptTimer: NodeJS.Timeout | undefined;
  private wanted = false;
  /** While the pill is dragged: where on the window (its own coordinates) the pointer holds it. */
  private drag: { grab: { x: number; y: number }; timer: NodeJS.Timeout } | undefined;

  constructor(private readonly options: PillWindowOptions) {
    const place = () => this.place();
    screen.on("display-added", place);
    screen.on("display-removed", place);
    screen.on("display-metrics-changed", place);
    options.transcript.on("change", () => this.transcriptChanged());
  }

  get webContents(): Electron.WebContents | undefined {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : undefined;
  }

  /** Show or hide it (from shouldShowPill). Hidden, the window is destroyed: nothing lingers. */
  setVisible(visible: boolean): void {
    if (visible === this.wanted) return;
    this.wanted = visible;
    if (visible) this.open();
    else this.close();
  }

  /** The current view, for `pill:get` and pushes. */
  view(): PillView {
    const r = this.options.recording();
    const layout = this.layout ?? this.restingLayout();
    return {
      expanded: this.hover.isExpanded,
      layout: { panel: layout.panel, pill: layout.pill, panelSide: layout.panelSide },
      recording: { state: r.state, title: r.title, startedAt: r.startedAt, stoppingSince: r.stoppingSince, transcription: r.transcription },
      transcript: this.hover.isExpanded ? this.options.transcript.view() : { segments: [], pending: [] },
    };
  }

  /** The recording changed (state, title…): redraw. */
  push(): void {
    this.send("pill", this.view());
  }

  /** The helper's `levels`, for the meter; nothing else is forwarded. */
  helperEvent(event: HelperEvent): void {
    if (event.event === "levels") this.send("helper", event);
  }

  /** The pointer went down on the pill at `at` (the window's coordinates) and moved: follow the
   * cursor until `dragEnd`. The panel closes for the ride. */
  dragStart(at: { x: number; y: number }): void {
    const w = this.window;
    if (!w || w.isDestroyed() || !this.layout || this.drag) return;
    const { pill } = this.layout;
    if (at.x < pill.x || at.x > pill.x + pill.width || at.y < pill.y || at.y > pill.y + pill.height) return;
    const was = this.hover.isExpanded;
    this.hover.reset();
    if (!this.mouse) w.setIgnoreMouseEvents(false);
    this.mouse = true;
    this.drag = { grab: { x: at.x - pill.x, y: at.y - pill.y }, timer: setInterval(() => this.dragTick(), DRAG_MS) };
    if (was) this.push();
  }

  /** The button came up: the pill settles on the nearer side edge of the display it's on, and
   * that's where it opens from now on. */
  dragEnd(): void {
    const w = this.window;
    const drag = this.drag;
    if (!drag) return;
    clearInterval(drag.timer);
    this.drag = undefined;
    if (!w || w.isDestroyed() || !this.layout) return;
    const at = { x: this.layout.window.x + this.layout.pill.x, y: this.layout.window.y + this.layout.pill.y };
    const display = screen.getDisplayNearestPoint({ x: at.x + this.layout.pill.width / 2, y: at.y + this.layout.pill.height / 2 });
    const position = snapPill(at, display.workArea);
    this.options.places.set(withPillPlace(this.options.places.value, String(display.id), position));
    this.layout = pillLayout(display.workArea, position);
    w.setBounds(this.layout.window);
    this.push();
    this.options.log(`floating recorder moved: ${position.edge} edge`);
  }

  /** Recording → Move Recorder Back to the Corner: forget every remembered spot. */
  resetPosition(): void {
    this.options.places.set({ displays: {} });
    this.options.log("floating recorder: back to the corner");
    this.place();
  }

  private dragTick(): void {
    const w = this.window;
    const drag = this.drag;
    if (!w || w.isDestroyed() || !this.layout || !drag) return;
    const cursor = screen.getCursorScreenPoint();
    const { pill } = this.layout;
    const at = clampPill({ x: cursor.x - drag.grab.x, y: cursor.y - drag.grab.y }, screen.getDisplayNearestPoint(cursor).workArea);
    const x = at.x - pill.x;
    const y = at.y - pill.y;
    if (x === this.layout.window.x && y === this.layout.window.y) return;
    // The window keeps its shape for the ride (part of it may hang off the screen; that part is
    // see-through and ignores the mouse); the panel's side is worked out again on release.
    this.layout = { ...this.layout, window: { ...this.layout.window, x, y } };
    w.setBounds(this.layout.window);
  }

  /** Where it opens: the display it was last dragged on (else the one under the cursor), at the
   * spot remembered for that display (else the bottom-right corner). */
  private restingLayout(): PillLayout {
    const displays = screen.getAllDisplays();
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const place = pillPlaceFor(this.options.places.value, displays.map((d) => String(d.id)), String(cursor.id));
    const display = displays.find((d) => String(d.id) === place.display) ?? cursor;
    return pillLayout(display.workArea, place.position);
  }

  private open(): void {
    if (this.window) return;
    this.hover.reset();
    this.mouse = false;
    this.layout = this.restingLayout();
    const mac = process.platform === "darwin";
    const w = new BrowserWindow({
      ...this.layout.window,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Never key or main: the meeting app keeps focus. The first click on the pill still counts.
      focusable: false,
      acceptFirstMouse: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A non-activating NSPanel: floats over full-screen apps without activating Every App.
      ...(mac ? { type: "panel" as const } : {}),
      roundedCorners: false,
      title: "Scribe recorder",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        // Keep the meter moving while Every App is in the background (it always is).
        backgroundThrottling: false,
      },
    });
    this.window = w;
    w.setAlwaysOnTop(true, "floating");
    // skipTransformProcessType: the panel type already floats over full-screen Spaces; without it
    // Electron would turn Every App into a UI element app and hide its Dock icon.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    if (mac) w.setHiddenInMissionControl(true);
    w.setIgnoreMouseEvents(true, { forward: true });
    w.once("ready-to-show", () => {
      if (this.window !== w || !this.wanted) return;
      w.showInactive();
      this.startPolling();
    });
    w.on("closed", () => {
      if (this.window === w) this.window = undefined;
      this.stopPolling();
      if (this.drag) clearInterval(this.drag.timer);
      this.drag = undefined;
    });
    if (this.options.devUrl) void w.loadURL(new URL("pill.html", this.options.devUrl).toString());
    else void w.loadFile(join(__dirname, "../renderer/pill.html"));
    this.options.log("floating recorder shown");
  }

  private close(): void {
    this.stopPolling();
    if (this.drag) clearInterval(this.drag.timer);
    this.drag = undefined;
    this.hover.reset();
    const w = this.window;
    this.window = undefined;
    this.layout = undefined;
    if (w && !w.isDestroyed()) {
      w.destroy();
      this.options.log("floating recorder hidden");
    }
  }

  /** The display the pill is on, else the one under the cursor. */
  private display(): Display {
    const w = this.window;
    if (w && !w.isDestroyed()) return screen.getDisplayMatching(w.getBounds());
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  /** Displays changed (one added, removed, resized, the Dock moved): back to its spot on the
   * display it's on now, the corner if it was never dragged there. */
  private place(): void {
    const w = this.window;
    if (!w || w.isDestroyed()) return;
    if (this.drag) clearInterval(this.drag.timer);
    this.drag = undefined;
    const display = this.display();
    this.layout = pillLayout(display.workArea, this.options.places.value.displays[String(display.id)]);
    w.setBounds(this.layout.window);
    this.push();
  }

  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(() => this.tick(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = undefined;
  }

  private tick(): void {
    const w = this.window;
    if (!w || w.isDestroyed() || !this.layout || this.drag) return;
    const zone = zoneAt(screen.getCursorScreenPoint(), this.layout);
    const was = this.hover.isExpanded;
    const expanded = this.hover.update(zone, Date.now());
    const mouse = takesMouse(zone, expanded);
    if (mouse !== this.mouse) {
      this.mouse = mouse;
      if (mouse) w.setIgnoreMouseEvents(false);
      else w.setIgnoreMouseEvents(true, { forward: true });
    }
    if (expanded !== was) this.push();
  }

  /** Transcript pushes only while the panel is open, at most every 100 ms. */
  private transcriptChanged(): void {
    if (!this.window || !this.hover.isExpanded || this.transcriptTimer) return;
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = undefined;
      if (this.hover.isExpanded) this.push();
    }, TRANSCRIPT_PUSH_MS);
  }

  private send(channel: string, payload: unknown): void {
    const wc = this.webContents;
    if (wc) wc.send(channel, payload);
  }
}
