// The optional global shortcut, ⌃⌥⌘R: start a recording from anywhere, or stop the running one.
// Off by default (Settings → recordShortcut). If another app already holds the combination,
// registration fails; that's reported as "conflict" on the snapshot rather than retried or
// remapped. No Electron import: globalShortcut is injected (tested).

export const RECORD_SHORTCUT = "Control+Alt+Command+R";

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export class RecordShortcut {
  private current: "off" | "on" | "conflict" = "off";

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly toggle: () => void,
    private readonly log: (line: string) => void = () => {},
  ) {}

  get status(): "off" | "on" | "conflict" {
    return this.current;
  }

  /** Turns it on or off; returns the resulting status. */
  set(enabled: boolean): "off" | "on" | "conflict" {
    if (this.current === "on") this.registry.unregister(RECORD_SHORTCUT);
    if (!enabled) {
      this.current = "off";
      return this.current;
    }
    let ok = false;
    try {
      ok = this.registry.register(RECORD_SHORTCUT, () => this.toggle());
    } catch {
      ok = false;
    }
    this.current = ok ? "on" : "conflict";
    this.log(ok ? "record shortcut ⌃⌥⌘R on" : "record shortcut ⌃⌥⌘R is taken by another app; left off");
    return this.current;
  }
}
