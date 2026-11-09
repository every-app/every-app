// The main window: hidden-inset title bar, vibrancy, remembers its size and place. Closing it
// hides it (the app stays in the tray); the Dock icon shows only while it's open.

import { app, BrowserWindow, screen } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const DEFAULT: Bounds = { width: 1100, height: 720 };

function boundsFile(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function loadBounds(): Bounds {
  try {
    if (!existsSync(boundsFile())) return DEFAULT;
    const b = JSON.parse(readFileSync(boundsFile(), "utf8")) as Bounds;
    if (typeof b.width !== "number" || typeof b.height !== "number") return DEFAULT;
    // Only keep a position that's still on a screen.
    if (typeof b.x === "number" && typeof b.y === "number") {
      const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x! < a.x + a.width - 50 && b.x! + b.width > a.x + 50 && b.y! >= a.y - 10 && b.y! < a.y + a.height - 50);
      if (!visible) return { width: b.width, height: b.height };
    }
    return b;
  } catch {
    return DEFAULT;
  }
}

export class MainWindow {
  private window: BrowserWindow | undefined;
  quitting = false;

  constructor(private readonly preloadPath: string) {}

  get webContents(): Electron.WebContents | undefined {
    return this.window?.webContents;
  }

  show(): void {
    if (!this.window) this.create();
    const w = this.window!;
    if (w.isMinimized()) w.restore();
    void app.dock?.show();
    w.show();
    w.focus();
  }

  private create(): void {
    const b = loadBounds();
    const w = new BrowserWindow({
      ...b,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: app.getName(),
      titleBarStyle: "hiddenInset",
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
      },
    });
    this.window = w;
    w.once("ready-to-show", () => w.show());
    const save = () => {
      if (w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return;
      try {
        writeFileSync(boundsFile(), JSON.stringify(w.getNormalBounds()));
      } catch {
        // Not important.
      }
    };
    w.on("resized", save);
    w.on("moved", save);
    w.on("close", (e) => {
      save();
      if (this.quitting) return;
      // Keep running in the tray.
      e.preventDefault();
      w.hide();
      app.dock?.hide();
    });
    w.on("closed", () => {
      this.window = undefined;
    });
    // Navigation and window.open are guarded for every webContents in index.ts (navigation.ts).
    if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) {
      void w.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void w.loadFile(join(__dirname, "../renderer/index.html"));
    }
  }

  /** Shows the window and sends once its page has loaded (a fresh window would miss it). */
  showAndSend(channel: string, payload: unknown): void {
    this.show();
    const wc = this.window?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (wc.isLoading()) wc.once("did-finish-load", () => this.send(channel, payload));
    else this.send(channel, payload);
  }

  send(channel: string, payload: unknown): void {
    const wc = this.window?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  }
}
