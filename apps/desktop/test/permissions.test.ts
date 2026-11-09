import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelperEvent } from "@shared/protocol";
import { combinePermissions, helperIdentity, PermissionProbe } from "../src/main/permissions";

const tempPath = () => join(mkdtempSync(join(tmpdir(), "everyapp-perms-")), "permissions.json");
const levels = (system: number, mic = 0.2): HelperEvent => ({ event: "levels", mic, system });
const helperSays = { mic: "granted", systemAudio: "unknown" } as const;
const REAL = "/Applications/Every App.app/Contents/MacOS/everyapp-helper|812345|1762041600000|0.1.0";

describe("system audio probe", () => {
  it("stays unknown while the tap is silent", () => {
    const probe = new PermissionProbe(tempPath());
    probe.load();
    probe.setHelper(REAL);
    expect(probe.observe(levels(0))).toBe(false);
    expect(probe.observe(levels(0.001))).toBe(false);
    expect(probe.observe({ event: "state", recording: true, mode: "realtime", mic: "ok", system: "ok" })).toBe(false);
    expect(probe.snapshot(helperSays).systemAudio).toBe("unknown");
  });

  it("is verified by the first sound on the system channel, and remembers it", () => {
    const path = tempPath();
    const probe = new PermissionProbe(path);
    probe.load();
    probe.setHelper(REAL);
    let changes = 0;
    probe.on("change", () => changes++);
    expect(probe.observe(levels(0.05))).toBe(true);
    expect(probe.observe(levels(0.3))).toBe(false);
    expect(changes).toBe(1);
    expect(probe.snapshot(helperSays)).toEqual({ mic: "granted", systemAudio: "verified", notifications: "unknown" });
    expect(JSON.parse(readFileSync(path, "utf8")).systemAudioVerifiedAt).toEqual(expect.any(String));
    const again = new PermissionProbe(path);
    again.load();
    again.setHelper(REAL);
    expect(again.systemAudioVerified).toBe(true);
  });

  it("ignores mic sound and junk levels", () => {
    const probe = new PermissionProbe(tempPath());
    probe.load();
    probe.setHelper(REAL);
    expect(probe.observe(levels(0, 0.9))).toBe(false);
    expect(probe.observe({ event: "levels", mic: 0, system: "loud" } as never)).toBe(false);
    expect(probe.systemAudioVerified).toBe(false);
  });

  it("remembers the notification answer", () => {
    const path = tempPath();
    const probe = new PermissionProbe(path);
    probe.load();
    probe.setHelper(REAL);
    probe.notificationResult(false);
    expect(probe.snapshot(helperSays).notifications).toBe("denied");
    probe.notificationResult(true);
    const again = new PermissionProbe(path);
    again.load();
    again.setHelper(REAL);
    expect(again.snapshot(helperSays).notifications).toBe("granted");
  });

  it("treats a broken file as nothing seen", () => {
    const path = tempPath();
    writeFileSync(path, '{"systemAudioVerifiedAt": 5, "notifications": "maybe"}');
    const probe = new PermissionProbe(path);
    probe.load();
    probe.setHelper(REAL);
    expect(probe.snapshot(undefined)).toEqual({ mic: "unknown", systemAudio: "unknown", notifications: "unknown" });
  });
});

describe("combining with the helper", () => {
  it("lets the helper's answer win when it has one", () => {
    expect(combinePermissions({ mic: "denied", systemAudio: "denied" }, { systemAudioVerified: true }).systemAudio).toBe("denied");
    expect(combinePermissions({ mic: "granted", systemAudio: "granted" }, { systemAudioVerified: false }).systemAudio).toBe("granted");
    expect(combinePermissions({ mic: "undetermined", systemAudio: "undetermined" }, { systemAudioVerified: true })).toEqual({
      mic: "undetermined",
      systemAudio: "verified",
      notifications: "unknown",
    });
    expect(combinePermissions(undefined, { systemAudioVerified: false, notifications: "granted" })).toEqual({
      mic: "unknown",
      systemAudio: "unknown",
      notifications: "granted",
    });
  });
});

describe("whose levels count", () => {
  it("identifies a real helper binary and refuses the fake one", () => {
    const real = { path: "/Applications/Every App Dev.app/Contents/MacOS/everyapp-helper", size: 812345, mtimeMs: 1762041600000.4, version: "0.1.0", macos: "26.5.1" };
    expect(helperIdentity(real)).toBe("/Applications/Every App Dev.app/Contents/MacOS/everyapp-helper|812345|1762041600000|0.1.0");
    expect(helperIdentity({ ...real, path: "/repo/desktop/scripts/fake-helper.mjs" })).toBeUndefined();
    // Every App Dev's packaged fake: a shell wrapper at the real path, but hello gives it away.
    expect(helperIdentity({ ...real, version: "0.0.0-fake", macos: "fake" })).toBeUndefined();
    expect(helperIdentity({ ...real, size: undefined })).toBeUndefined();
    expect(helperIdentity({ ...real, mtimeMs: real.mtimeMs + 5000 })).not.toBe(helperIdentity(real));
  });

  it("ignores levels from the fake helper (or before any helper said hello)", () => {
    const probe = new PermissionProbe(tempPath());
    probe.load();
    expect(probe.observe(levels(0.4))).toBe(false); // no helper yet
    probe.setHelper(undefined); // the fake
    expect(probe.observe(levels(0.4))).toBe(false);
    expect(probe.snapshot(helperSays).systemAudio).toBe("unknown");
  });

  it("doesn't carry a fake run's file over to a real helper (the Codex V2 case)", () => {
    const path = tempPath();
    // What an older build left behind after a fake-helper recording.
    writeFileSync(path, JSON.stringify({ systemAudioVerifiedAt: "2026-11-02T03:00:00Z" }));
    const probe = new PermissionProbe(path);
    probe.load();
    probe.setHelper(REAL);
    expect(probe.snapshot(helperSays).systemAudio).toBe("unknown");
    expect(JSON.parse(readFileSync(path, "utf8")).systemAudioVerifiedAt).toBeUndefined();
  });

  it("starts over when the helper changes (a rebuild), and keeps it across restarts of the same one", () => {
    const path = tempPath();
    const probe = new PermissionProbe(path);
    probe.load();
    probe.setHelper(REAL);
    probe.observe(levels(0.2));
    const sameAgain = new PermissionProbe(path);
    sameAgain.load();
    sameAgain.setHelper(REAL);
    expect(sameAgain.snapshot(helperSays).systemAudio).toBe("verified");
    const rebuilt = new PermissionProbe(path);
    rebuilt.load();
    let changes = 0;
    rebuilt.on("change", () => changes++);
    rebuilt.setHelper(REAL.replace("|0.1.0", "|0.1.1"));
    expect(rebuilt.snapshot(helperSays).systemAudio).toBe("unknown");
    rebuilt.setHelper(REAL); // and back: the old proof was cleared, not kept
    expect(rebuilt.snapshot(helperSays).systemAudio).toBe("unknown");
    expect(changes).toBe(0); // it was never verified for these helpers
  });

  it("takes the verification back when the tap errors", () => {
    const probe = new PermissionProbe(tempPath());
    probe.load();
    probe.setHelper(REAL);
    probe.observe(levels(0.2));
    let changes = 0;
    probe.on("change", () => changes++);
    probe.observe({ event: "state", recording: true, mode: "realtime", mic: "ok", system: "silent" });
    expect(probe.snapshot(helperSays).systemAudio).toBe("verified"); // silence alone is a quiet call
    probe.observe({ event: "state", recording: true, mode: "realtime", mic: "ok", system: "error" });
    expect(probe.snapshot(helperSays).systemAudio).toBe("unknown");
    expect(changes).toBe(1);
    expect(probe.observe(levels(0.3))).toBe(true); // sound again verifies again
  });
});
