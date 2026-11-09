// "Copy Diagnostics" (Help menu): what someone helping needs, nothing private. Versions, the
// connection, sign-in method and app host (no email, no tokens), settings, helper health and
// crash counts, recording state (no title or transcript), pending uploads, and the last 50 log
// lines (redacted again in case). No Electron import (tested).

import type { AppSnapshot } from "@shared/ipc";
import { redact } from "./logfile";

export interface DiagnosticsInput {
  snapshot: AppSnapshot;
  versions: { app: string; electron?: string; chrome?: string; node?: string; os: string; arch: string };
  recordingCrashes: number;
  pendingUploads: number;
  logTail: string[];
}

const host = (url: string | undefined) => {
  if (!url) return "none";
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
};

export function buildDiagnostics(d: DiagnosticsInput): string {
  const s = d.snapshot;
  const lines = [
    `Every App ${d.versions.app} diagnostics, ${new Date().toISOString()}`,
    `Electron ${d.versions.electron ?? "?"}, Chrome ${d.versions.chrome ?? "?"}, Node ${d.versions.node ?? "?"}, ${d.versions.os} (${d.versions.arch})`,
    `Helper: ${s.helper.status}${s.helper.version ? ` ${s.helper.version}` : ""}${s.helper.macos ? ` (macOS ${s.helper.macos})` : ""}, restarts ${s.helper.restarts}, crashes ${s.helper.crashes}, recordings cut short ${d.recordingCrashes}${s.helper.lastError ? `, last error: ${s.helper.lastError}` : ""}`,
    `Connection: ${s.connection}`,
    `Sign-in: ${s.auth.status}${s.auth.method ? ` (${s.auth.method})` : ""}, app ${host(s.auth.appUrl)}${s.auth.expired ? ", expired" : ""}${s.auth.needsEveryAppSignIn ? ", needs Sign in with Every App" : ""}`,
    `Recording: ${s.recording.state}${s.recording.mode ? `, ${s.recording.mode}` : ""}${s.recording.mic ? `, mic ${s.recording.mic}` : ""}${s.recording.system ? `, system ${s.recording.system}` : ""}${s.recording.transcription ? `, transcription ${s.recording.transcription}` : ""}`,
    `Pending uploads: ${d.pendingUploads}`,
    `Permissions: mic ${s.permissions.mic}, system audio ${s.permissions.systemAudio}, notifications ${s.permissions.notifications}`,
    `Settings: ${JSON.stringify(s.settings)}`,
    `Login item: ${s.loginItem.status}; calendar connected ${s.calendar.connected}, ${s.calendar.events.length} upcoming; updater ${s.updater.enabled ? `${s.updater.state}${s.updater.version ? ` ${s.updater.version}` : ""}${s.updater.deferred ? " (deferred)" : ""}` : "off"}; record shortcut ${s.recordShortcut}`,
    "",
    `Last ${d.logTail.length} log lines:`,
    ...d.logTail.map(redact),
  ];
  return `${lines.join("\n")}\n`;
}
