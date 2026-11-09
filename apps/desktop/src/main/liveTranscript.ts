// The live transcript main keeps for the floating recorder: the newest turns of the recording in
// progress, folded from the helper's `transcript.delta` / `transcript.segment` events. Bounded (the
// last ~50 turns), in memory only, and dropped when the recording ends. No Electron import.

import { EventEmitter } from "node:events";
import type { HelperEvent } from "@shared/protocol";
import type { PillView } from "@shared/ipc";
import { emptyTranscript, reduceBoundedTranscript, type LiveTranscript, type TranscriptLimits } from "@shared/transcript";

export const TRANSCRIPT_LIMITS: TranscriptLimits = { segments: 50, pending: 4, chars: 2000 };

export class LiveTranscriptBuffer extends EventEmitter<{ change: [] }> {
  private state: LiveTranscript = emptyTranscript;

  constructor(private readonly limits: TranscriptLimits = TRANSCRIPT_LIMITS) {
    super();
  }

  get value(): LiveTranscript {
    return this.state;
  }

  /** Feed every helper event; only transcript events (and a new meeting's `state`) matter. */
  observe(event: HelperEvent): void {
    if (event.event !== "state" && event.event !== "transcript.delta" && event.event !== "transcript.segment") return;
    this.set(reduceBoundedTranscript(this.state, event, this.limits));
  }

  /** A recording starts (a new meeting id) or ends (undefined): start clean. */
  reset(meetingId?: string): void {
    if (this.state.meetingId === meetingId && this.state.segments.length === 0 && this.state.pending.length === 0) return;
    this.set({ ...emptyTranscript, meetingId });
  }

  /** What the pill's panel draws: committed turns, then the ones still being spoken. */
  view(): PillView["transcript"] {
    return {
      segments: this.state.segments,
      pending: this.state.pending.filter((p) => p.text.trim()).map(({ speaker, text }) => ({ speaker, text })),
    };
  }

  private set(next: LiveTranscript): void {
    if (next === this.state) return;
    this.state = next;
    this.emit("change");
  }
}
