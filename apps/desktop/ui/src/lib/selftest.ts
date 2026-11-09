/**
 * "Check microphone & Mac audio": what each side's row says, from the helper's report so far.
 * Short words for a person, no how-to: a side that stays quiet for a few seconds just says so,
 * with the System Settings pane to open.
 */
import type { SelfTestReport, SelfTestSide } from "../types";

/** A side with no sound for this long (whole seconds heard) is marked quiet. */
export const QUIET_AFTER_SECONDS = 3;

export interface SelfTestRow {
  side: "mic" | "system";
  label: string;
  /** The input device (mic), or the output device the Mac's sound plays through. */
  device?: string;
  /** "waiting": nothing heard yet, but it's too early to say. */
  tone: "ok" | "waiting" | "warn" | "bad";
  text: string;
  /** Offer "Open Settings" for this permission. */
  openSettings?: "mic" | "systemAudio";
}

/**
 * The two rows. `report` is the latest progress (undefined before the first one); `finished`
 * when the check has ended, so a side still quiet is quiet however short it ran.
 */
export function selfTestRows(
  report: SelfTestReport | undefined,
  finished = false,
): SelfTestRow[] {
  const quiet = finished || (report?.seconds ?? 0) >= QUIET_AFTER_SECONDS;
  return [
    row("mic", "Microphone", report?.mic, quiet),
    row("system", "Mac audio", report?.system, quiet),
  ];
}

function row(
  side: "mic" | "system",
  label: string,
  s: SelfTestSide | undefined,
  quiet: boolean,
): SelfTestRow {
  const base = { side, label, device: s?.device };
  const pane = side === "mic" ? "mic" : "systemAudio";
  if (!s) return { ...base, tone: "waiting", text: "Listening…" };
  switch (s.status) {
    case "ok":
      return s.clipping
        ? { ...base, tone: "warn", text: "Working, but too loud" }
        : { ...base, tone: "ok", text: "Working" };
    case "error":
      return {
        ...base,
        tone: "bad",
        text: "Couldn't start",
        openSettings: side === "system" ? pane : undefined,
      };
    case "denied":
      // The mic's permission is known at once. The Mac's "denied" is only digital silence,
      // which is also what nothing playing sounds like, so it waits like "silent".
      if (side === "mic")
        return {
          ...base,
          tone: "bad",
          text: "Access is off",
          openSettings: pane,
        };
    // falls through
    case "silent":
      return quiet
        ? { ...base, tone: "bad", text: "No sound", openSettings: pane }
        : { ...base, tone: "waiting", text: "Listening…" };
  }
}
