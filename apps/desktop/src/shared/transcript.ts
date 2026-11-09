// The live transcript of a recording, folded from the helper's events: committed turns
// (`transcript.segment`) and turns still being spoken (`transcript.delta`, which carries the whole
// turn so far for its itemId). Pure, so main (the floating recorder's bounded buffer) and the
// window (the meeting page) share it.

import type { Segment } from "./contract";
import type { HelperEvent, Speaker } from "./protocol";

export interface PendingTurn {
  itemId: string;
  speaker: Speaker;
  text: string;
}

export interface LiveTranscript {
  /** The meeting these belong to (from the helper's `state` event). */
  meetingId?: string;
  segments: Segment[];
  /** Turns still being spoken, by itemId, in arrival order. */
  pending: PendingTurn[];
}

/** Caps for a bounded transcript: the newest `segments`, `pending` turns and `chars` per turn. */
export interface TranscriptLimits {
  segments: number;
  pending: number;
  chars: number;
}

export const emptyTranscript: LiveTranscript = { segments: [], pending: [] };

/** Keeps the end of a long turn: the newest words are the ones on screen. */
function clip(text: string, chars: number): string {
  return text.length > chars ? `…${text.slice(text.length - chars + 1)}` : text;
}

/** Folds one helper event in. Unbounded: the meeting page keeps every line. */
export function reduceTranscript(state: LiveTranscript, event: HelperEvent): LiveTranscript {
  return reduce(state, event);
}

/** The same, keeping only the newest turns within `limits` (main's buffer for the pill). */
export function reduceBoundedTranscript(state: LiveTranscript, event: HelperEvent, limits: TranscriptLimits): LiveTranscript {
  return reduce(state, event, limits);
}

function reduce(state: LiveTranscript, event: HelperEvent, limits?: TranscriptLimits): LiveTranscript {
  switch (event.event) {
    case "state":
      // A new recording starts clean.
      if (event.meetingId && event.meetingId !== state.meetingId) return { ...emptyTranscript, meetingId: event.meetingId };
      return state;
    case "transcript.delta": {
      const at = state.pending.findIndex((p) => p.itemId === event.itemId);
      const text = limits ? clip(event.text, limits.chars) : event.text;
      const item = { itemId: event.itemId, speaker: event.speaker, text };
      let pending = at === -1 ? [...state.pending, item] : state.pending.map((p, i) => (i === at ? item : p));
      // Turns the helper never committed (it shouldn't happen) don't pile up: the oldest go.
      if (limits && pending.length > limits.pending) pending = pending.slice(pending.length - limits.pending);
      return { ...state, pending };
    }
    case "transcript.segment": {
      if (state.segments.some((s) => s.seq === event.seq)) return state;
      const segment: Segment = {
        seq: event.seq,
        speaker: event.speaker,
        text: limits ? clip(event.text, limits.chars) : event.text,
        startedMs: event.startedMs,
        endedMs: event.endedMs,
      };
      let segments = [...state.segments, segment].sort((a, b) => a.seq - b.seq);
      if (limits && segments.length > limits.segments) segments = segments.slice(segments.length - limits.segments);
      // The committed turn replaces that speaker's oldest text in flight.
      const done = state.pending.findIndex((p) => p.speaker === event.speaker);
      return {
        ...state,
        segments,
        pending: done === -1 ? state.pending : state.pending.filter((_, i) => i !== done),
      };
    }
    default:
      return state;
  }
}
