// Helper protocol v1 (docs/desktop-plan.md, "Helper protocol (v1)"). Newline-delimited JSON on
// the helper's stdin/stdout; logs on stderr. Change this only together with Lane H and the plan.

export const HELPER_PROTOCOL = 1;

export type PermissionStatus = "granted" | "denied" | "undetermined" | "unknown";
export type Speaker = "me" | "them";

export interface SelfTestRequest {
  /** 1–60, default 60: the check runs until `selftest.stop` or this many seconds. */
  seconds?: number;
}

/** One side of a self-test. System audio "denied" means only digital silence came through: what
 * a tap without permission delivers, and also what nothing playing sounds like. */
export interface SelfTestSide {
  status: "ok" | "silent" | "denied" | "error";
  peak: number;
  sampleRate?: number;
  device?: string;
  clipping: boolean;
  clippedSamples: number;
  dropouts: number;
  message?: string;
}

/** `seconds`: whole seconds heard so far (0 in the first `selftest.progress`). */
export interface SelfTestReport {
  seconds: number;
  passed: boolean;
  mic: SelfTestSide;
  system: SelfTestSide;
}

export type TranscriptionState = "live" | "reconnecting" | "catching_up";

/** A finished transcript line, as posted to /api/v1/meetings/:id/segments. */
export interface TranscriptSegment {
  /** Time-based, not consecutive: startedMs × 4 + (them ? 2 : 0) + (replayed ? 1 : 0). */
  seq: number;
  speaker: Speaker;
  text: string;
  startedMs: number;
  endedMs: number;
}
export type ChannelHealth = "ok" | "silent" | "error";

/** Each request `cmd`, its params and its result. */
export interface HelperCommands {
  hello: { params: { protocol: number }; result: { protocol: number; version: string; macos: string } };
  "permissions.status": {
    params: undefined;
    result: { mic: PermissionStatus; systemAudio: PermissionStatus };
  };
  "permissions.request": {
    params: { kind: "mic" | "systemAudio" };
    result: { mic: PermissionStatus; systemAudio: PermissionStatus };
  };
  "record.start": {
    params: { meetingId: string; apiBase: string; accessToken: string; language?: string };
    result: { startedAt: string };
  };
  /** `cancelled`: the stop came while record.start was still starting; nothing was captured and
   * the start answers error `cancelled`. */
  /** `finished: false`: /finish failed. `unsaved`: segments that never posted (deduped, final
   * seqs), handed back for main to replay (segments first, then /finish). Both optional. */
  "record.stop": { params: undefined; result: { segments: number; cancelled?: boolean; finished?: boolean; unsaved?: TranscriptSegment[] } };
  "token.update": { params: { accessToken: string }; result: Record<string, never> };
  "detect.set": { params: { enabled: boolean }; result: Record<string, never> };
  /** Captures both sides locally (no network, nothing saved) until `selftest.stop` or
   * `seconds`, streaming `levels` (10 Hz) and `selftest.progress` (each second) meanwhile, and
   * answers the report. `busy` while recording; record.start is `busy` during it. */
  "selftest.run": { params: SelfTestRequest; result: SelfTestReport };
  /** Ends a running self-test (its selftest.run then answers). `stopped: false` if none ran. */
  "selftest.stop": { params: undefined; result: { stopped: boolean } };
}

export type HelperCommand = keyof HelperCommands;

export interface HelperRequest<C extends HelperCommand = HelperCommand> {
  id: number;
  cmd: C;
  params?: HelperCommands[C]["params"];
}

export interface HelperError {
  code: string;
  message: string;
}

export type HelperResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: HelperError };

/** Each event name and its fields (sent flat: `{ "event": "levels", "mic": 0.2, "system": 0 }`). */
export interface HelperEvents {
  state: {
    recording: boolean;
    meetingId?: string;
    mode: "realtime" | "fallback";
    mic: ChannelHealth;
    system: ChannelHealth;
    /** "reconnecting": a speaker's Realtime channel is down (its audio is kept, up to 5 minutes).
     * "catching_up": back, and the kept audio is being transcribed through the fallback while
     * live audio goes on. Then "live" again. */
    transcription?: TranscriptionState;
  };
  levels: { mic: number; system: number };
  "transcript.delta": { speaker: Speaker; text: string; itemId: string };
  "transcript.segment": { seq: number; speaker: Speaker; text: string; startedMs: number; endedMs: number };
  "token.needed": Record<string, never>;
  "call.started": { bundleId: string; appName: string };
  "call.ended": { bundleId: string; appName: string };
  "device.changed": { input?: string; output?: string };
  /** A self-test's report so far: once both captures start (`seconds` 0, with the devices),
   * then each second. */
  "selftest.progress": SelfTestReport;
  error: { code: string; message: string; fatal: boolean };
}

export type HelperEventName = keyof HelperEvents;

export type HelperEvent = {
  [K in HelperEventName]: { event: K } & HelperEvents[K];
}[HelperEventName];

/** One line from the helper: a response (has `id`) or an event (has `event`). */
export type HelperMessage = { kind: "response"; response: HelperResponse } | { kind: "event"; event: HelperEvent };

export function parseHelperLine(line: string): HelperMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id === "number" && typeof obj.ok === "boolean") {
    return { kind: "response", response: obj as unknown as HelperResponse };
  }
  if (typeof obj.event === "string") return { kind: "event", event: obj as unknown as HelperEvent };
  return null;
}
