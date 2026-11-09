// Update checks and "Restart to Update". Runs only when the build has a feed (EVERYAPP_DESKTOP_UPDATE_URL at
// build time). It checks in the background on launch and every 6 hours, but only while signed in
// and online, plus "Check for Updates…" on demand. A downloaded update is offered as "Restart to
// Update". It never restarts during a recording: asking then defers it, and it's offered again
// after Stop. A feed on the signed-in app's own origin gets the API's bearer (updateAuth.ts).
// No Electron import: the updater (electron-updater's autoUpdater, or a fake) is injected.

import { EventEmitter } from "node:events";
import type { UpdateSnapshot } from "@shared/ipc";
import { updateRequest } from "./updateAuth";

export const CHECK_INTERVAL_MS = 6 * 3600_000;

/** The slice of electron-updater's autoUpdater that's used. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  requestHeaders: Record<string, string> | null;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "checking-for-update" | "update-not-available", listener: () => void): unknown;
  on(event: "update-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
}

export interface UpdateControllerOptions {
  updater: Updater;
  /** The feed URL (app-update.yml's `url`), for deciding whether it gets the bearer. */
  feedUrl?: string;
  appUrl(): string | undefined;
  accessToken(): Promise<string | undefined>;
  freshAccessToken(): Promise<string | undefined>;
  /** Background checks only while signed in and online. */
  canCheck(): boolean;
  isRecording(): boolean;
  log?: (line: string) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

export interface UpdateEvents {
  change: [UpdateSnapshot];
  /** An update finished downloading (once per version). */
  ready: [{ version: string }];
  /** A deferred restart can happen now: the recording stopped. */
  offer: [{ version: string }];
}

export class UpdateController extends EventEmitter<UpdateEvents> {
  private snapshot: UpdateSnapshot = { enabled: true, state: "idle" };
  private checking = false;
  private announced: string | undefined;

  constructor(private readonly options: UpdateControllerOptions) {
    super();
    const u = options.updater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.on("checking-for-update", () => this.set({ state: "checking", error: undefined }));
    u.on("update-available", (i) => this.set({ state: "downloading", version: i.version, progress: 0 }));
    u.on("download-progress", (p) => {
      if (this.snapshot.state !== "downloading" || typeof p?.percent !== "number") return;
      const progress = Math.max(0, Math.min(1, Math.round(p.percent) / 100));
      // Only whole percents: a change event per byte would flood the window.
      if (progress !== this.snapshot.progress) this.set({ progress });
    });
    u.on("update-not-available", () => {
      if (this.snapshot.state !== "ready") this.set({ state: "upToDate" });
    });
    u.on("update-downloaded", (i) => {
      this.set({ state: "ready", version: i.version, progress: undefined });
      if (this.announced !== i.version) {
        this.announced = i.version;
        this.options.log?.(`update ${i.version} downloaded; restart to install`);
        this.emit("ready", { version: i.version });
      }
    });
    u.on("error", (e) => {
      this.options.log?.(`update error: ${e.message}`);
      // A downloaded update stays ready; a failed later check doesn't take it away.
      if (this.snapshot.state !== "ready") this.set({ state: "error", error: e.message });
    });
  }

  get state(): UpdateSnapshot {
    return this.snapshot;
  }

  /** Background checks: now (if it may) and every 6 hours. */
  start(): void {
    void this.check(false);
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms).unref());
    every(() => void this.check(false), CHECK_INTERVAL_MS);
  }

  /** `manual`: "Check for Updates…" (runs even when the background rules would skip, as long as
   * a private feed has a sign-in). Resolves when the check is done. */
  async check(manual: boolean): Promise<void> {
    if (this.checking) return;
    if (this.snapshot.state === "ready") return; // nothing newer to fetch until it's installed
    if (!manual && !this.options.canCheck()) return;
    this.checking = true;
    try {
      if (!(await this.prepare(false))) {
        this.set({ state: "error", error: "Sign in to check for updates." });
        return;
      }
      await this.options.updater.checkForUpdates();
    } catch (error) {
      if (/\b401\b/.test(String(error)) && (await this.prepare(true).catch(() => false))) {
        await this.options.updater.checkForUpdates().catch((e: unknown) => this.failed(e));
      } else {
        this.failed(error);
      }
    } finally {
      this.checking = false;
      this.set({ lastCheck: new Date((this.options.now ?? Date.now)()).toISOString() });
    }
  }

  /** Restart into the downloaded update, unless a recording is running (then it's deferred and
   * offered after Stop). */
  install(): { deferred: boolean } {
    if (this.snapshot.state !== "ready") return { deferred: false };
    if (this.options.isRecording()) {
      this.options.log?.("update: restart deferred until the recording stops");
      this.set({ deferred: true });
      return { deferred: true };
    }
    this.options.log?.(`update: restarting into ${this.snapshot.version}`);
    this.options.updater.quitAndInstall(false, true);
    return { deferred: false };
  }

  /** The recording stopped: offer a deferred restart. */
  recordingStopped(): void {
    if (this.snapshot.state !== "ready" || !this.snapshot.deferred) return;
    this.set({ deferred: false });
    this.emit("offer", { version: this.snapshot.version ?? "" });
  }

  private async prepare(fresh: boolean): Promise<boolean> {
    const token = fresh ? await this.options.freshAccessToken() : await this.options.accessToken();
    const r = updateRequest(this.options.feedUrl, this.options.appUrl(), token);
    if (r.skip) return false;
    this.options.updater.requestHeaders = r.headers;
    return true;
  }

  private failed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.log?.(`update check failed: ${message}`);
    if (this.snapshot.state !== "ready") this.set({ state: "error", error: message });
  }

  private set(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("change", this.snapshot);
  }
}

/** The "Restart to Update" menu item (app menu and tray), or null when there's nothing to install.
 * During a recording it's shown but disabled: the restart waits for Stop. */
export function restartItem(updater: UpdateSnapshot, recordingState: string): { label: string; enabled: boolean } | null {
  if (!updater.enabled || updater.state !== "ready") return null;
  const version = updater.version ? ` (${updater.version})` : "";
  if (recordingState !== "idle") return { label: `Restart to Update${version} after this recording`, enabled: false };
  return { label: `Restart to Update${version}`, enabled: true };
}

/** "Check for Updates…": always shown, so it can be found (and tested). Without a feed, clicking
 * it explains that updates aren't set up in this build; disabled while a check runs. */
export function checkItem(updater: UpdateSnapshot): { label: string; enabled: boolean } {
  if (!updater.enabled) return { label: "Check for Updates…", enabled: true };
  const busy = updater.state === "checking" || updater.state === "downloading";
  return { label: updater.state === "downloading" ? "Downloading Update…" : "Check for Updates…", enabled: !busy && updater.state !== "ready" };
}

/** A stand-in updater for e2e runs (EVERYAPP_DESKTOP_E2E_FAKE_UPDATE=<version>, dev builds only): a check
 * finds that version and "downloads" it at once; installing just logs. */
export function fakeUpdater(version: string, log: (line: string) => void = () => {}): Updater & { installs: number } {
  const listeners = new Map<string, ((arg?: unknown) => void)[]>();
  const emit = (event: string, arg?: unknown) => (listeners.get(event) ?? []).forEach((l) => l(arg));
  const fake = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    requestHeaders: null as Record<string, string> | null,
    installs: 0,
    on(event: string, listener: (arg?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fake;
    },
    async checkForUpdates() {
      emit("checking-for-update");
      emit("update-available", { version });
      setTimeout(() => emit("update-downloaded", { version }), 50);
      return {};
    },
    quitAndInstall() {
      fake.installs++;
      log(`fake updater: would restart into ${version}`);
    },
  };
  return fake as Updater & { installs: number };
}
