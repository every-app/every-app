// The macOS side of settings and permissions: the login item, the theme, System Settings deep
// links and the notification permission.

import { app, nativeTheme, Notification } from "electron";
import type { LoginItemSnapshot, PermissionKind, ThemePreference } from "@shared/ipc";

/** System Settings panes, by permission. "System Audio Recording Only" lives in the Screen & System
 * Audio Recording pane. Notifications open on Every App's own row. */
export function settingsPaneUrl(pane: PermissionKind, bundleId: string): string {
  const privacy = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";
  switch (pane) {
    case "mic":
      return `${privacy}?Privacy_Microphone`;
    case "systemAudio":
      return `${privacy}?Privacy_ScreenCapture`;
    case "notifications":
      return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(bundleId)}`;
  }
}

/** macOS registers a login item only for a real bundle, so an unpackaged run is "unsupported". */
export function loginItemSupported(): boolean {
  return process.platform === "darwin" && app.isPackaged;
}

export function loginItemStatus(): LoginItemSnapshot {
  if (!loginItemSupported()) return { status: "unsupported" };
  const s = app.getLoginItemSettings();
  if (s.status === "requires-approval") return { status: "requiresApproval" };
  return { status: s.status === "enabled" || s.openAtLogin ? "enabled" : "disabled" };
}

/** Registers or removes Every App as a login item (SMAppService main app service on macOS 13+). */
export function applyLoginItem(enabled: boolean, log: (line: string) => void): LoginItemSnapshot {
  if (!loginItemSupported()) return { status: "unsupported" };
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (error) {
    log(`login item: couldn't ${enabled ? "register" : "remove"} (${String(error)})`);
  }
  return loginItemStatus();
}

export function applyTheme(theme: ThemePreference): void {
  nativeTheme.themeSource = theme;
}

/** Shows a notification, which makes macOS ask the first time. Resolves true when it was shown,
 * false when macOS refused it, undefined when there was no answer in time. */
export function requestNotificationPermission(): Promise<boolean | undefined> {
  if (!Notification.isSupported()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const n = new Notification({
      title: "Every App can remind you",
      body: "You'll get a reminder before meetings and when a call starts.",
      silent: true,
    });
    // A first-time prompt waits on the person; give it a while.
    const timer = setTimeout(() => resolve(undefined), 120_000);
    n.once("show", () => {
      clearTimeout(timer);
      resolve(true);
    });
    n.once("failed", () => {
      clearTimeout(timer);
      resolve(false);
    });
    n.show();
  });
}
