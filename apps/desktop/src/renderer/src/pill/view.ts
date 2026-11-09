// What the floating recorder says under its transcript. Pure, for the tests.

import type { PillView } from "@shared/ipc";

export function pillNotice(recording: PillView["recording"]): string | undefined {
  if (recording.state === "stopping") return "Finishing the transcript…";
  if (recording.state === "starting") return "Starting…";
  if (recording.transcription === "reconnecting") return "Reconnecting to transcription. Your audio is kept.";
  if (recording.transcription === "catching_up") return "Catching up on the transcript…";
  return undefined;
}

/** No `levels` for this long (the helper stopped, or is stopping): the meter goes flat. */
export const LEVELS_STALE_MS = 500;
