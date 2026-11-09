import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { checkItem, restartItem, UpdateController, type Updater } from "../src/main/updates";
import { RECORD_SHORTCUT, RecordShortcut } from "../src/main/shortcut";
import type { UpdateSnapshot } from "@shared/ipc";

/** A fake electron-updater autoUpdater: tests decide what a check finds. */
class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  requestHeaders: Record<string, string> | null = null;
  checks = 0;
  installs = 0;
  headersSeen: (Record<string, string> | null)[] = [];
  next: "none" | { version: string } | Error = "none";
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  async checkForUpdates(): Promise<unknown> {
    this.checks++;
    this.headersSeen.push(this.requestHeaders);
    this.emit("checking-for-update");
    const next = this.next;
    if (next instanceof Error) throw next;
    if (next === "none") {
      this.emit("update-not-available");
      return {};
    }
    this.emit("update-available", next);
    this.emit("download-progress", { percent: 42.4 });
    this.emit("update-downloaded", next);
    return {};
  }
  quitAndInstall(): void {
    this.installs++;
  }
}

function make(opts: Partial<{ signedIn: boolean; online: boolean; recording: boolean; feedUrl: string; token: string | undefined }> = {}) {
  const o = { signedIn: true, online: true, recording: false, feedUrl: "https://talk.example.com/api/v1/updates/mac", token: "tok" as string | undefined, ...opts };
  const updater = new FakeUpdater();
  const intervals: { fn: () => void; ms: number }[] = [];
  const c = new UpdateController({
    updater,
    feedUrl: o.feedUrl,
    appUrl: () => "https://talk.example.com",
    accessToken: async () => o.token,
    freshAccessToken: async () => (o.token ? `${o.token}-fresh` : undefined),
    canCheck: () => o.signedIn && o.online,
    isRecording: () => o.recording,
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
  });
  const ready: string[] = [];
  const offers: string[] = [];
  const states: UpdateSnapshot["state"][] = [];
  c.on("ready", ({ version }) => ready.push(version));
  c.on("offer", ({ version }) => offers.push(version));
  c.on("change", (s) => states.push(s.state));
  return { c, updater, intervals, ready, offers, states, o };
}

describe("update controller", () => {
  it("turns on auto-download and install-on-quit", () => {
    const { updater } = make();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("checks at launch and every 6 hours, with the bearer for a feed on the app's origin", async () => {
    const { c, updater, intervals } = make();
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(updater.checks).toBe(1);
    expect(updater.headersSeen[0]).toEqual({ Authorization: "Bearer tok" });
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.ms).toBe(6 * 3600_000);
    intervals[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(updater.checks).toBe(2);
    expect(c.state).toMatchObject({ state: "upToDate", lastCheck: expect.any(String) });
  });

  it("skips background checks while signed out or offline; a manual check still runs", async () => {
    const offline = make({ online: false });
    await offline.c.check(false);
    expect(offline.updater.checks).toBe(0);
    await offline.c.check(true);
    expect(offline.updater.checks).toBe(1);
    const signedOut = make({ signedIn: false, token: undefined });
    await signedOut.c.check(true); // a private feed needs the sign-in
    expect(signedOut.updater.checks).toBe(0);
    expect(signedOut.c.state).toMatchObject({ state: "error", error: expect.stringMatching(/Sign in/) });
  });

  it("sends no credentials to a feed on another host", async () => {
    const { c, updater } = make({ feedUrl: "https://bucket.r2.dev/talk" });
    await c.check(false);
    expect(updater.headersSeen[0]).toBeNull();
  });

  it("downloads, reports progress, and announces ready once per version", async () => {
    const { c, updater, ready, states } = make();
    updater.next = { version: "0.2.0" };
    await c.check(false);
    expect(states).toEqual(expect.arrayContaining(["checking", "downloading", "ready"]));
    expect(c.state).toMatchObject({ state: "ready", version: "0.2.0", progress: undefined });
    expect(ready).toEqual(["0.2.0"]);
    // Nothing more to fetch until it's installed.
    await c.check(true);
    expect(updater.checks).toBe(1);
    expect(ready).toEqual(["0.2.0"]);
  });

  it("restarts into the update when idle", async () => {
    const { c, updater } = make();
    updater.next = { version: "0.2.0" };
    await c.check(false);
    expect(c.install()).toEqual({ deferred: false });
    expect(updater.installs).toBe(1);
  });

  it("never restarts during a recording: defers, then offers after Stop", async () => {
    const h = make({ recording: true });
    h.updater.next = { version: "0.2.0" };
    await h.c.check(false);
    expect(h.c.install()).toEqual({ deferred: true });
    expect(h.updater.installs).toBe(0);
    expect(h.c.state.deferred).toBe(true);
    h.o.recording = false;
    h.c.recordingStopped();
    expect(h.offers).toEqual(["0.2.0"]);
    expect(h.c.state.deferred).toBe(false);
    h.c.recordingStopped(); // only once
    expect(h.offers).toHaveLength(1);
  });

  it("does nothing when asked to install with nothing downloaded", () => {
    const { c, updater } = make();
    expect(c.install()).toEqual({ deferred: false });
    expect(updater.installs).toBe(0);
  });

  it("refreshes the token once after a 401, and keeps a ready update through later errors", async () => {
    const { c, updater } = make();
    updater.next = new Error("HttpError: 401 Unauthorized");
    await c.check(false);
    expect(updater.headersSeen).toEqual([{ Authorization: "Bearer tok" }, { Authorization: "Bearer tok-fresh" }]);
    expect(c.state.state).toBe("error");
    updater.next = { version: "0.3.0" };
    await c.check(false);
    expect(c.state.state).toBe("ready");
    updater.emit("error", new Error("later network blip"));
    expect(c.state).toMatchObject({ state: "ready", version: "0.3.0" });
  });
});

describe("update menu items", () => {
  const ready: UpdateSnapshot = { enabled: true, state: "ready", version: "0.2.0" };
  it("offers Restart to Update when ready, disabled during a recording", () => {
    expect(restartItem(ready, "idle")).toEqual({ label: "Restart to Update (0.2.0)", enabled: true });
    expect(restartItem(ready, "recording")).toEqual({ label: "Restart to Update (0.2.0) after this recording", enabled: false });
    expect(restartItem({ enabled: true, state: "upToDate" }, "idle")).toBeNull();
    expect(restartItem({ enabled: false, state: "idle" }, "idle")).toBeNull();
  });
  it("shows Check for Updates only with a feed, disabled while busy", () => {
    // Always there (Codex V3 couldn't find it in a build without a feed); it explains when clicked.
    expect(checkItem({ enabled: false, state: "idle" })).toEqual({ label: "Check for Updates…", enabled: true });
    expect(checkItem({ enabled: true, state: "idle" })).toEqual({ label: "Check for Updates…", enabled: true });
    expect(checkItem({ enabled: true, state: "checking" })!.enabled).toBe(false);
    expect(checkItem({ enabled: true, state: "downloading" })).toEqual({ label: "Downloading Update…", enabled: false });
    expect(checkItem(ready)!.enabled).toBe(false);
  });
});

describe("record shortcut", () => {
  function registry(taken = false) {
    const registered = new Map<string, () => void>();
    return {
      registered,
      register: (accelerator: string, fn: () => void) => {
        if (taken) return false;
        registered.set(accelerator, fn);
        return true;
      },
      unregister: (accelerator: string) => void registered.delete(accelerator),
    };
  }

  it("is off until turned on, toggles recording, and unregisters when turned off", () => {
    const r = registry();
    let toggles = 0;
    const s = new RecordShortcut(r, () => toggles++);
    expect(s.status).toBe("off");
    expect(s.set(true)).toBe("on");
    expect(RECORD_SHORTCUT).toBe("Control+Alt+Command+R");
    r.registered.get(RECORD_SHORTCUT)!();
    expect(toggles).toBe(1);
    expect(s.set(false)).toBe("off");
    expect(r.registered.size).toBe(0);
  });

  it("reports a conflict instead of fighting another app for the keys", () => {
    const s = new RecordShortcut(registry(true), () => {});
    expect(s.set(true)).toBe("conflict");
    expect(s.set(false)).toBe("off");
  });
});
