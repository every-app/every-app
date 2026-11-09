// This Mac's settings and permissions, the bridge-free part (for the tests). Main stores the
// settings (userData/settings.json) and pushes them on the state snapshot; the controller shows a
// change at once and settles on what main answers.

import type { AppSnapshot, PermissionKind, PermissionsSnapshot, Settings, SettingsPatch, DesktopBridge } from "@shared/ipc";
import type { PermissionStatus } from "@shared/protocol";

export type DeviceSettings = Settings;

type SettingsBridge = Pick<DesktopBridge, "settings:get" | "settings:set">;

export class SettingsController {
  private stored: DeviceSettings | undefined;
  private pending: Partial<DeviceSettings> = {};
  private readonly listeners = new Set<() => void>();
  private snapshot: DeviceSettings | undefined;

  constructor(private readonly bridge: SettingsBridge) {}

  /** What the switches show: main's value with changes still on their way laid over it. */
  get value(): DeviceSettings | undefined {
    return this.snapshot;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Read main's settings again (on mount, so a page never shows stale switches). */
  async load(): Promise<void> {
    this.receive(await this.bridge["settings:get"]());
  }

  /** A value main pushed (the state snapshot). */
  receive(settings: DeviceSettings): void {
    this.stored = settings;
    this.emit();
  }

  async set(patch: SettingsPatch): Promise<void> {
    this.pending = { ...this.pending, ...patch };
    this.emit();
    try {
      this.stored = await this.bridge["settings:set"](patch);
    } finally {
      // Drop what this change asked for, unless a newer change asked again.
      for (const key of Object.keys(patch) as (keyof DeviceSettings)[]) {
        if (this.pending[key] === patch[key]) delete this.pending[key];
      }
      this.emit();
    }
  }

  private emit() {
    this.snapshot = this.stored ? { ...this.stored, ...this.pending } : undefined;
    for (const l of this.listeners) l();
  }
}

/** "verified" means a system-audio tap delivered sound: granted, as far as the window cares. */
export function asUiStatus(status: PermissionsSnapshot[PermissionKind]): PermissionStatus {
  return status === "verified" ? "granted" : status;
}

export function uiPermissions(p: PermissionsSnapshot | undefined): Record<PermissionKind, PermissionStatus> {
  return {
    mic: asUiStatus(p?.mic ?? "unknown"),
    systemAudio: asUiStatus(p?.systemAudio ?? "unknown"),
    notifications: asUiStatus(p?.notifications ?? "unknown"),
  };
}

const where: Record<PermissionKind, string> = {
  mic: "Allow Every App in System Settings → Privacy & Security → Microphone.",
  systemAudio: "Allow Every App in System Settings → Privacy & Security → Screen & System Audio Recording.",
  notifications: "Allow notifications for Every App in System Settings.",
};

type PermissionBridge = Pick<DesktopBridge, "permissions:request" | "permissions:openSettings">;

/**
 * Grant: a blocked permission opens its System Settings pane; otherwise ask (for notifications,
 * main shows one to trigger macOS's prompt). Answers the hint to show when it still isn't on.
 */
export async function grantPermission(
  bridge: PermissionBridge,
  kind: PermissionKind,
  current: PermissionStatus,
): Promise<{ status: PermissionStatus; hint?: string }> {
  if (current === "denied") {
    await bridge["permissions:openSettings"](kind);
    return { status: current, hint: where[kind] };
  }
  const status = asUiStatus((await bridge["permissions:request"](kind))[kind]);
  return status === "granted" ? { status } : { status, hint: where[kind] };
}

export function loginItemHint(status: string | undefined, wanted: boolean): string | undefined {
  if (status === "requiresApproval") return "Allow Every App in System Settings → General → Login Items.";
  if (status === "unsupported") return "Only in the installed app; a dev run can't open at login.";
  if (wanted && status === "disabled") return "macOS hasn't turned it on yet.";
  return undefined;
}

/** Why "Check microphone & Mac audio" can't start right now, if it can't. */
export function selfTestBlockedReason(state: AppSnapshot | undefined, runningHere: boolean): string | undefined {
  if (!state) return undefined;
  if (state.recording.state !== "idle") return "Stop the recording to check your microphone and Mac audio.";
  if (state.selfTest?.running && !runningHere) return "Every App is already checking your microphone and Mac audio.";
  return undefined;
}

/** Why New note (and ⌘N) can't start right now: main refuses a recording during a test. */
export function newNoteBlockedReason(state: AppSnapshot | undefined): string | undefined {
  return state?.selfTest?.running ? "Every App is checking your microphone and Mac audio. Stop the check in Settings to start recording." : undefined;
}
