// The live view of a recording, from the helper's events: levels (≤10 Hz), text still being
// spoken (`transcript.delta`, which carries the whole turn so far for its itemId) and committed
// turns (`transcript.segment`). The reducer (src/shared/transcript.ts) is pure for the tests; the
// store feeds React.

import { useSyncExternalStore } from "react";
import type { Segment } from "@shared/contract";
import type { HelperEvent, SelfTestReport, Speaker } from "@shared/protocol";
import { emptyTranscript, reduceTranscript, type LiveTranscript } from "@shared/transcript";

export { emptyTranscript, reduceTranscript, type LiveTranscript };

/** Text in flight per speaker, as the transcript view wants it. */
export function partialOf(state: LiveTranscript): { me: string; them: string } {
  const join = (speaker: Speaker) =>
    state.pending
      .filter((p) => p.speaker === speaker)
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(" ");
  return { me: join("me"), them: join("them") };
}

/** The API's segments plus the live ones the API hasn't caught up with, by seq. */
export function mergeSegments(saved: Segment[], live: Segment[]): Segment[] {
  const seen = new Set(saved.map((s) => s.seq));
  return [...saved, ...live.filter((s) => !seen.has(s.seq))].sort((a, b) => a.seq - b.seq);
}

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const levels = store({ mic: 0, system: 0 });
const transcript = store<LiveTranscript>(emptyTranscript);
const selfTestProgress = store<SelfTestReport | undefined>(undefined);

/** Feed one helper event into the stores. */
export function applyHelperEvent(event: HelperEvent): void {
  if (event.event === "levels") levels.set({ mic: event.mic, system: event.system });
  else if (event.event === "selftest.progress") {
    const { event: _name, ...report } = event;
    selfTestProgress.set(report);
  } else transcript.set(reduceTranscript(transcript.get(), event));
}

/** Forget the last audio check's progress (a new check starts clean). */
export function resetSelfTestProgress(): void {
  selfTestProgress.set(undefined);
  levels.set({ mic: 0, system: 0 });
}

/** The running audio check's report so far (the helper's `selftest.progress`). */
export function useSelfTestProgress(): SelfTestReport | undefined {
  return useSyncExternalStore(selfTestProgress.subscribe, selfTestProgress.get);
}

export function useLevels(): { mic: number; system: number } {
  return useSyncExternalStore(levels.subscribe, levels.get);
}

export function useLiveTranscript(): LiveTranscript {
  return useSyncExternalStore(transcript.subscribe, transcript.get);
}
