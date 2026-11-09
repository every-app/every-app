// The app's settings (src/shared/ipc.ts `Settings`) as JSON in userData/settings.json. Main owns
// the file; the renderer reads and patches it over IPC, and every patch is checked here first
// because the renderer is untrusted. No Electron import, so it's testable under plain Node.

import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SETTINGS, MAX_REMINDER_LEAD_MINUTES, type Settings, type SettingsPatch, type ThemePreference } from "@shared/ipc";

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

const checks: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  launchAtLogin: (v): v is boolean => typeof v === "boolean",
  callDetection: (v): v is boolean => typeof v === "boolean",
  reminderLeadMinutes: (v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_REMINDER_LEAD_MINUTES,
  theme: (v): v is ThemePreference => THEMES.includes(v as ThemePreference),
  recordShortcut: (v): v is boolean => typeof v === "boolean",
  floatingRecorder: (v): v is boolean => typeof v === "boolean",
};

/** A valid patch, or null: a plain object with only known keys, each with a valid value. */
export function parseSettingsPatch(value: unknown): SettingsPatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(checks, key)) return null;
    const check = (checks as Record<string, (v: unknown) => boolean>)[key]!;
    if (!check(v)) return null;
    out[key] = v;
  }
  return out as SettingsPatch;
}

/** Reads a stored file leniently: keeps each valid field, defaults the rest. */
export function readSettings(value: unknown): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (!value || typeof value !== "object" || Array.isArray(value)) return settings;
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(checks) as (keyof Settings)[]) {
    if (checks[key](o[key])) (settings as unknown as Record<string, unknown>)[key] = o[key];
  }
  return settings;
}

export class SettingsStore extends EventEmitter<{ change: [Settings, SettingsPatch] }> {
  private current: Settings = { ...DEFAULT_SETTINGS };

  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    super();
  }

  get value(): Settings {
    return { ...this.current };
  }

  load(): Settings {
    try {
      this.current = readSettings(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`settings: unreadable, using defaults (${String(error)})`);
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.value;
  }

  /** Applies a patch (validate it with parseSettingsPatch first) and saves; emits the changed keys. */
  set(patch: SettingsPatch): Settings {
    const valid = parseSettingsPatch(patch);
    if (!valid) throw new Error("Invalid settings.");
    const changed: SettingsPatch = {};
    for (const [key, v] of Object.entries(valid) as [keyof Settings, never][]) {
      if (this.current[key] !== v) (changed as Record<string, unknown>)[key] = v;
    }
    if (Object.keys(changed).length === 0) return this.value;
    this.current = { ...this.current, ...changed };
    this.save();
    this.emit("change", this.value, changed);
    return this.value;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      this.log(`settings: couldn't save (${String(error)})`);
    }
  }
}
