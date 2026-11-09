// What Every App knows about its permissions beyond the helper's `permissions.status`:
//
// - System audio: macOS has no API to read "System Audio Recording Only", so the helper says
//   "unknown". A denied tap delivers pure silence, so the first `levels` event with sound on the
//   system channel proves the grant. That is remembered (userData/permissions.json) and reported as
//   "verified".
// - Notifications: Electron can't read the macOS authorization either. Showing one does ask, and
//   Electron then emits `show` (allowed) or `failed` (refused); the last answer is remembered.
//
// No Electron import, so it's testable under plain Node.

import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HelperEvent, PermissionStatus } from "@shared/protocol";
import type { PermissionsSnapshot, SystemAudioStatus } from "@shared/ipc";

/** A `levels.system` above this is sound. Levels are peak RMS rounded to 0.001; a denied tap is 0. */
export const SYSTEM_AUDIO_THRESHOLD = 0.001;

interface ProbeFile {
  systemAudioVerifiedAt?: string;
  /** The helper that delivered the sound (helperIdentity); verification counts only for it. */
  systemAudioHelper?: string;
  notifications?: "granted" | "denied";
}

/** Who the running helper is, for keying "verified": its binary (path, size, modification time)
 * and its hello version. Undefined for the fake helper (a script, or hello says "fake"), whose
 * made-up levels must never count. */
export function helperIdentity(
  helper: { path: string; size?: number; mtimeMs?: number; version?: string; macos?: string },
): string | undefined {
  if (/\.(c|m)?js$/.test(helper.path)) return undefined;
  if ((helper.version ?? "").includes("fake") || helper.macos === "fake") return undefined;
  if (helper.size === undefined || helper.mtimeMs === undefined || !helper.version) return undefined;
  return `${helper.path}|${helper.size}|${Math.round(helper.mtimeMs)}|${helper.version}`;
}

export type HelperPermissions = { mic: PermissionStatus; systemAudio: PermissionStatus };

/** The helper's statuses plus what the probe has seen. A denial from the helper always wins. */
export function combinePermissions(helper: HelperPermissions | undefined, probe: { systemAudioVerified: boolean; notifications?: "granted" | "denied" }): PermissionsSnapshot {
  const raw = helper?.systemAudio ?? "unknown";
  let systemAudio: SystemAudioStatus;
  if (raw === "denied" || raw === "granted") systemAudio = raw;
  else if (probe.systemAudioVerified) systemAudio = "verified";
  else systemAudio = raw;
  return { mic: helper?.mic ?? "unknown", systemAudio, notifications: probe.notifications ?? "unknown" };
}

export class PermissionProbe extends EventEmitter<{ change: [] }> {
  private state: ProbeFile = {};
  /** The running helper (helperIdentity), set once it says hello; undefined: nothing counts. */
  private helper: string | undefined;

  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    super();
  }

  /** Verified by the helper that's running now (a real one). */
  get systemAudioVerified(): boolean {
    return !!this.helper && !!this.state.systemAudioVerifiedAt && this.state.systemAudioHelper === this.helper;
  }

  /** The helper said hello (identity from helperIdentity; undefined for the fake helper). A
   * different helper than the one that verified system audio starts over. */
  setHelper(identity: string | undefined): void {
    const before = this.systemAudioVerified;
    this.helper = identity;
    if (identity && this.state.systemAudioVerifiedAt && this.state.systemAudioHelper !== identity) {
      this.log("permissions: a different helper than the one that verified system audio; checking again");
      this.clearVerification();
    }
    if (before !== this.systemAudioVerified) this.emit("change");
  }

  get notifications(): "granted" | "denied" | undefined {
    return this.state.notifications;
  }

  load(): void {
    try {
      const o = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      this.state = {
        systemAudioVerifiedAt: typeof o.systemAudioVerifiedAt === "string" ? o.systemAudioVerifiedAt : undefined,
        systemAudioHelper: typeof o.systemAudioHelper === "string" ? o.systemAudioHelper : undefined,
        notifications: o.notifications === "granted" || o.notifications === "denied" ? o.notifications : undefined,
      };
    } catch {
      this.state = {};
    }
  }

  /** Feed every helper event; returns true when it just verified system audio. Only a real helper
   * counts. The tap erroring (`state.system: "error"`) takes the verification back. */
  observe(event: HelperEvent): boolean {
    if (event.event === "state" && event.recording && event.system === "error" && this.state.systemAudioVerifiedAt) {
      this.log("permissions: the system-audio tap errored; checking again");
      this.clearVerification();
      this.emit("change");
      return false;
    }
    if (!this.helper || this.systemAudioVerified || event.event !== "levels") return false;
    if (!(typeof event.system === "number" && event.system > SYSTEM_AUDIO_THRESHOLD)) return false;
    this.state = { ...this.state, systemAudioVerifiedAt: new Date().toISOString(), systemAudioHelper: this.helper };
    this.log("permissions: system audio verified (the tap delivered sound)");
    this.save();
    this.emit("change");
    return true;
  }

  /** A notification was shown (`granted`) or refused (`denied`). */
  notificationResult(granted: boolean): void {
    const value = granted ? "granted" : "denied";
    if (this.state.notifications === value) return;
    this.state = { ...this.state, notifications: value };
    this.save();
    this.emit("change");
  }

  snapshot(helper: HelperPermissions | undefined): PermissionsSnapshot {
    return combinePermissions(helper, { systemAudioVerified: this.systemAudioVerified, notifications: this.state.notifications });
  }

  private clearVerification(): void {
    this.state = { ...this.state, systemAudioVerifiedAt: undefined, systemAudioHelper: undefined };
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      this.log(`permissions: couldn't save (${String(error)})`);
    }
  }
}
