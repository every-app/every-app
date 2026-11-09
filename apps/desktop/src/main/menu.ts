// The app menu and the Dock menu. Everything in the tray menu is here too (Open Every App, Start and
// Stop Recording), so it's reachable from the keyboard, by accessibility tools and by computer-use
// testers, which can't reach the menu bar's status items. Plus Settings… (⌘,), the standard Edit
// menu (what makes copy, paste and undo work in text fields) and Help → Show Logs / Copy
// Diagnostics.

import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { AppSnapshot } from "@shared/ipc";
import { checkItem, restartItem } from "./updates";

export interface MenuActions {
  open(): void;
  settings(): void;
  start(): void;
  stop(): void;
  showLogs(): void;
  /** Dev builds only (absent in a release): clears the onboarding-seen flag. */
  resetOnboarding?: () => void;
  copyDiagnostics(): void;
  checkForUpdates(): void;
  installUpdate(): void;
}

/** The recording items, shared by the app menu and the Dock menu. No accelerators: the window
 * owns its own shortcuts (⌘N starts notes there). */
export function recordingItems(s: Pick<AppSnapshot, "auth" | "helper" | "recording" | "selfTest">, actions: MenuActions): MenuItemConstructorOptions[] {
  const r = s.recording.state;
  const busy = r !== "idle";
  return [
    { label: "Start Recording", enabled: s.auth.status === "signedIn" && !busy && s.helper.status === "ready" && !s.selfTest.running, click: () => actions.start() },
    { label: "Stop Recording", enabled: r === "recording" || r === "starting", click: () => actions.stop() },
  ];
}

export class AppMenu {
  private lastKey = "";

  constructor(private readonly actions: MenuActions) {}

  private updateItems(s: AppSnapshot): MenuItemConstructorOptions[] {
    const check = checkItem(s.updater);
    const restart = restartItem(s.updater, s.recording.state);
    const items: MenuItemConstructorOptions[] = [];
    items.push({ label: check.label, enabled: check.enabled, click: () => this.actions.checkForUpdates() });
    if (restart) items.push({ label: restart.label, enabled: restart.enabled, click: () => this.actions.installUpdate() });
    return items;
  }

  update(s: AppSnapshot): void {
    const key = JSON.stringify([s.auth.status, s.helper.status, s.recording.state, s.selfTest.running, s.updater.enabled, s.updater.state, s.updater.version]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const recording = recordingItems(s, this.actions);
    const template: MenuItemConstructorOptions[] = [
      {
        label: app.getName(),
        submenu: [
          { role: "about" },
          { label: "Copy Diagnostics", click: () => this.actions.copyDiagnostics() },
          ...this.updateItems(s),
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => this.actions.settings() },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { label: "Recording", submenu: recording },
      ...(app.isPackaged ? [] : [{ role: "viewMenu" } as MenuItemConstructorOptions]),
      {
        role: "windowMenu",
        submenu: [
          { label: "Open Every App", click: () => this.actions.open() },
          { type: "separator" },
          { role: "minimize" },
          { role: "zoom" },
          { role: "close" },
          { type: "separator" },
          { role: "front" },
        ],
      },
      {
        role: "help",
        submenu: [
          { label: "Show Logs", click: () => this.actions.showLogs() },
          ...(this.actions.resetOnboarding
            ? [{ type: "separator" } as MenuItemConstructorOptions, { label: "Reset Onboarding", click: () => this.actions.resetOnboarding?.() }]
            : []),
          { label: "Copy Diagnostics", click: () => this.actions.copyDiagnostics() },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    app.dock?.setMenu(Menu.buildFromTemplate([{ label: "Open Every App", click: () => this.actions.open() }, { type: "separator" }, ...recording]));
  }
}
