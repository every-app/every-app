// The main-process log: userData's logs dir (~/Library/Logs/<app>/main.log on macOS), rotating
// 5 MB × 3, redacted (logfile.ts), plus the console. Never log tokens or transcript text.

import { app } from "electron";
import { join } from "node:path";
import { redact, RotatingLog } from "./logfile";

let file: RotatingLog | undefined;

function target(): RotatingLog | undefined {
  if (file) return file;
  try {
    file = new RotatingLog(join(app.getPath("logs"), "main.log"));
  } catch {
    file = undefined;
  }
  return file;
}

export function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? p.message : JSON.stringify(p))).join(" ")}`;
  console.log(redact(line));
  target()?.write(line);
}

/** Where the log is (for Help → Show Logs). */
export function logPath(): string | undefined {
  return target()?.path;
}

/** The last lines of the log (already redacted when written). */
export function logTail(n: number): string[] {
  return target()?.tail(n) ?? [];
}
