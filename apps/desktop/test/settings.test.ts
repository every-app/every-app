import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@shared/ipc";
import { parseSettingsPatch, readSettings, SettingsStore } from "../src/main/settings";
import { planReminders } from "../src/main/calendar/planner";

const tempPath = () => join(mkdtempSync(join(tmpdir(), "everyapp-settings-")), "settings.json");

describe("settings patches", () => {
  it("accepts known keys with valid values", () => {
    expect(parseSettingsPatch({})).toEqual({});
    expect(parseSettingsPatch({ theme: "dark", reminderLeadMinutes: 5 })).toEqual({ theme: "dark", reminderLeadMinutes: 5 });
    expect(parseSettingsPatch({ launchAtLogin: true, callDetection: false })).toEqual({ launchAtLogin: true, callDetection: false });
    expect(parseSettingsPatch({ reminderLeadMinutes: 0 })).toEqual({ reminderLeadMinutes: 0 });
    expect(parseSettingsPatch({ reminderLeadMinutes: 30 })).toEqual({ reminderLeadMinutes: 30 });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      undefined,
      "theme",
      [],
      { theme: "blue" },
      { reminderLeadMinutes: -1 },
      { reminderLeadMinutes: 31 },
      { reminderLeadMinutes: 1.5 },
      { reminderLeadMinutes: "1" },
      { launchAtLogin: "yes" },
      { callDetection: 1 },
      { echoCancellation: true }, // removed: an unknown key now
      { unknown: true },
      { theme: "dark", extra: 1 },
      new Date(),
      JSON.parse('{"__proto__": {"theme": "dark"}}'),
    ]) {
      expect(parseSettingsPatch(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("reads a stored file leniently, defaulting bad fields", () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ theme: "light", reminderLeadMinutes: 999, launchAtLogin: true, junk: 1, echoCancellation: true })).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "light",
      launchAtLogin: true,
    });
  });
});

describe("SettingsStore", () => {
  it("starts with the defaults: no login item, call detection on, 1 minute, system theme", () => {
    const store = new SettingsStore(tempPath());
    expect(store.load()).toEqual({ launchAtLogin: false, callDetection: true, reminderLeadMinutes: 1, theme: "system", recordShortcut: false, floatingRecorder: true });
  });

  it("saves a patch, emits only what changed, and reloads it", () => {
    const path = tempPath();
    const store = new SettingsStore(path);
    store.load();
    const changes: unknown[] = [];
    store.on("change", (_value, changed) => changes.push(changed));
    expect(store.set({ theme: "dark", callDetection: true })).toMatchObject({ theme: "dark", callDetection: true });
    expect(changes).toEqual([{ theme: "dark" }]);
    store.set({ theme: "dark" });
    expect(changes).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ theme: "dark" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new SettingsStore(path);
    expect(again.load().theme).toBe("dark");
  });

  it("refuses an invalid patch and keeps the old value", () => {
    const store = new SettingsStore(tempPath());
    store.load();
    expect(() => store.set({ reminderLeadMinutes: 100 })).toThrow();
    expect(store.value.reminderLeadMinutes).toBe(1);
  });

  it("survives a broken file", () => {
    const path = tempPath();
    writeFileSync(path, "{not json");
    const logs: string[] = [];
    expect(new SettingsStore(path, (l) => logs.push(l)).load()).toEqual(DEFAULT_SETTINGS);
    expect(logs[0]).toMatch(/unreadable/);
  });

  it("hands its copy out, not its state", () => {
    const store = new SettingsStore(tempPath());
    store.load();
    const v = store.value;
    v.theme = "dark";
    expect(store.value.theme).toBe("system");
  });
});

describe("reminder lead time", () => {
  it("fires the given minutes before a meeting", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    const event = { id: "a", title: "Sync", start: new Date(now + 30 * 60_000).toISOString(), attendees: [{ email: "me", self: true }, { email: "you" }] };
    const [one] = planReminders([event as never], now);
    const [ten] = planReminders([event as never], now, new Set(), undefined, 10 * 60_000);
    expect(Date.parse(event.start) - one!.fireAt).toBe(60_000);
    expect(Date.parse(event.start) - ten!.fireAt).toBe(10 * 60_000);
  });
});
