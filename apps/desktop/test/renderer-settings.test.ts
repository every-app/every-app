import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type PermissionsSnapshot, type Settings } from "@shared/ipc";
import { navigateTarget } from "../src/renderer/src/navigate";
import { SettingsController, grantPermission, loginItemHint, uiPermissions } from "../src/renderer/src/settings-logic";

function fakeSettingsBridge(initial: Settings = DEFAULT_SETTINGS) {
  let stored = { ...initial };
  return {
    stored: () => stored,
    "settings:get": vi.fn(async () => ({ ...stored })),
    "settings:set": vi.fn(async (patch: Partial<Settings>) => {
      stored = { ...stored, ...patch };
      return { ...stored };
    }),
  };
}

describe("settings controller (Codex V1: toggles reset after leaving Settings)", () => {
  it("re-reads main's settings, so a page that mounts again shows what was saved", async () => {
    const bridge = fakeSettingsBridge();
    const first = new SettingsController(bridge);
    await first.load();
    await first.set({ launchAtLogin: true, callDetection: false });
    // Leaving and coming back: a fresh page reads main again.
    const again = new SettingsController(bridge);
    expect(again.value).toBeUndefined();
    await again.load();
    expect(again.value).toMatchObject({ launchAtLogin: true, callDetection: false });
    expect(bridge["settings:get"]).toHaveBeenCalledTimes(2);
  });

  it("shows a change at once, then settles on main's answer", async () => {
    let answer!: (s: Settings) => void;
    const bridge = {
      "settings:get": async () => DEFAULT_SETTINGS,
      "settings:set": () => new Promise<Settings>((r) => (answer = r)),
    };
    const c = new SettingsController(bridge);
    await c.load();
    const saving = c.set({ launchAtLogin: true });
    expect(c.value?.launchAtLogin).toBe(true);
    answer({ ...DEFAULT_SETTINGS, launchAtLogin: true });
    await saving;
    expect(c.value?.launchAtLogin).toBe(true);
  });

  it("goes back to main's value when the save fails", async () => {
    const bridge = {
      "settings:get": async () => DEFAULT_SETTINGS,
      "settings:set": async () => Promise.reject(new Error("Refused")),
    };
    const c = new SettingsController(bridge);
    await c.load();
    await expect(c.set({ callDetection: false })).rejects.toThrow("Refused");
    expect(c.value?.callDetection).toBe(true);
  });

  it("follows main's pushes", async () => {
    const c = new SettingsController(fakeSettingsBridge());
    const seen: (boolean | undefined)[] = [];
    c.subscribe(() => seen.push(c.value?.launchAtLogin));
    c.receive({ ...DEFAULT_SETTINGS, launchAtLogin: true });
    expect(seen).toEqual([true]);
  });
});

describe("permissions", () => {
  const snapshot = (p: Partial<PermissionsSnapshot>): PermissionsSnapshot => ({ mic: "granted", systemAudio: "unknown", notifications: "unknown", ...p });

  it("asks for notifications, and explains when they're still off", async () => {
    const bridge = {
      "permissions:request": vi.fn(async () => snapshot({ notifications: "unknown" })),
      "permissions:openSettings": vi.fn(async () => {}),
    };
    const result = await grantPermission(bridge, "notifications", "unknown");
    expect(bridge["permissions:request"]).toHaveBeenCalledWith("notifications");
    expect(result).toEqual({ status: "unknown", hint: "Allow notifications for Every App in System Settings." });
  });

  it("reports a grant with no hint, and opens System Settings for a blocked one", async () => {
    const bridge = {
      "permissions:request": vi.fn(async () => snapshot({ notifications: "granted" })),
      "permissions:openSettings": vi.fn(async () => {}),
    };
    expect(await grantPermission(bridge, "notifications", "unknown")).toEqual({ status: "granted" });
    const blocked = await grantPermission(bridge, "mic", "denied");
    expect(bridge["permissions:openSettings"]).toHaveBeenCalledWith("mic");
    expect(blocked.hint).toMatch(/Microphone/);
  });

  it("reads a verified system-audio tap as granted", () => {
    expect(uiPermissions(snapshot({ systemAudio: "verified" })).systemAudio).toBe("granted");
  });

  it("says why open-at-login isn't on", () => {
    expect(loginItemHint("requiresApproval", true)).toMatch(/Login Items/);
    expect(loginItemHint("unsupported", false)).toMatch(/installed app/);
    expect(loginItemHint("disabled", true)).toMatch(/hasn't turned it on/);
    expect(loginItemHint("enabled", true)).toBeUndefined();
  });
});

describe("navigate requests from main", () => {
  it("maps the allowed pages and refuses anything else", () => {
    expect(navigateTarget({ to: "settings" })).toEqual({ to: "/settings" });
    expect(navigateTarget({ to: "home" })).toEqual({ to: "/" });
    expect(navigateTarget({ to: "meeting", meetingId: "m-1" })).toEqual({ to: "/meetings/$id", params: { id: "m-1" } });
    expect(navigateTarget({ to: "meeting", meetingId: "../x" })).toBeNull();
    expect(navigateTarget({ to: "admin" })).toBeNull();
    expect(navigateTarget("settings")).toBeNull();
  });
});

describe("Check microphone & Mac audio", () => {
  it("can't run during a recording, or while another test runs; blocks New note meanwhile", async () => {
    const { selfTestBlockedReason, newNoteBlockedReason } = await import("../src/renderer/src/settings-logic");
    const snap = (recording: string, running: boolean) =>
      ({ recording: { state: recording }, selfTest: { running } }) as unknown as Parameters<typeof selfTestBlockedReason>[0];
    expect(selfTestBlockedReason(snap("idle", false), false)).toBeUndefined();
    expect(selfTestBlockedReason(snap("recording", false), false)).toMatch(/Stop the recording/);
    expect(selfTestBlockedReason(snap("idle", true), false)).toMatch(/already checking/);
    // The window's own test running isn't a reason to disable its own button state.
    expect(selfTestBlockedReason(snap("idle", true), true)).toBeUndefined();
    expect(newNoteBlockedReason(snap("idle", true))).toMatch(/Stop the check/);
    expect(newNoteBlockedReason(snap("idle", false))).toBeUndefined();
  });
});
