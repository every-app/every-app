// The floating recorder: a small pill in the bottom-right corner of the screen while recording,
// over every app (full-screen ones too) and on every Space. It never takes focus from the meeting
// app. Resting the mouse on it opens the live transcript to its left; clicking it opens the
// meeting in Every App's window. The rules (when, where, hover) are in pill.ts.
//
// The window always covers the panel's area as well, so opening the panel needs no resize; it
// ignores the mouse (clicks go through) except over the pill or the open panel. Hover is read by
// polling the cursor, which works the same whether or not Every App is the active app.

import { BrowserWindow, screen, type Display } from "electron";
import { join } from "node:path";
import type { PillView, RecordingSnapshot } from "@shared/ipc";
import type { HelperEvent } from "@shared/protocol";
import type { LiveTranscriptBuffer } from "./liveTranscript";
import { HoverTracker, pillLayout, takesMouse, zoneAt, type PillLayout } from "./pill";

const POLL_MS = 50;
const TRANSCRIPT_PUSH_MS = 100;

export interface PillWindowOptions {
  preloadPath: string;
  /** The dev server (unpackaged runs), else the bundled page is loaded. */
  devUrl?: string;
  recording: () => RecordingSnapshot;
  transcript: LiveTranscriptBuffer;
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
    const layout = this.layout ?? pillLayout(this.display().workArea);
    return {
      expanded: this.hover.isExpanded,
      layout: { panel: layout.panel, pill: layout.pill },
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

  private open(): void {
    if (this.window) return;
    this.hover.reset();
    this.mouse = false;
    this.layout = pillLayout(this.display().workArea);
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
    });
    if (this.options.devUrl) void w.loadURL(new URL("pill.html", this.options.devUrl).toString());
    else void w.loadFile(join(__dirname, "../renderer/pill.html"));
    this.options.log("floating recorder shown");
  }

  private close(): void {
    this.stopPolling();
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

  /** Displays changed (one added, removed, resized, the Dock moved): back to the corner. */
  private place(): void {
    const w = this.window;
    if (!w || w.isDestroyed()) return;
    const display = this.display();
    this.layout = pillLayout(display.workArea);
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
    if (!w || w.isDestroyed() || !this.layout) return;
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
