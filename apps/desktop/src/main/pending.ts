// Transcript a recording couldn't save: the helper's record.stop hands back `unsaved` segments
// (and `finished: false` when /finish failed) when the app was unreachable or the sign-in had
// expired. They're kept as text only, one 0600 JSON file per meeting in userData/pending, and
// replayed once the app is reachable again (now, on reconnect, or next launch): segments in
// batches of ≤ 50 first, then /finish, so the notes include them. Re-posting is safe: the Worker
// ignores a seq it already has. No Electron import.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptSegment } from "@shared/protocol";
import { ApiError } from "./api/client";

/** Segments per replay POST. Small enough that the Worker's insert stays under D1's limit on SQL
 * variables (Codex V4: a 2-minute backlog in one POST failed with "too many SQL variables"). */
export const REPLAY_BATCH = 50;
/** Leftovers older than this are dropped rather than replayed into a long-gone meeting. */
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** A 4xx the Worker won't change its mind about (not 401, 404, 408, 409 or 429): the batch is
 * dropped instead of retried forever. 404 is handled apart: the meeting itself is gone. */
export function isPermanentRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.kind !== "server" || error.status === undefined) return false;
  return error.status >= 400 && error.status < 500 && ![401, 404, 408, 409, 429].includes(error.status);
}

export interface PendingMeeting {
  meetingId: string;
  /** The app the meeting lives on: replayed only while signed in to the same one. */
  appUrl: string;
  segments: TranscriptSegment[];
  /** /finish still has to be called. */
  needsFinish: boolean;
  savedAt: number;
}

export interface ReplayApi {
  appUrl: string;
  appendSegments(meetingId: string, segments: TranscriptSegment[]): Promise<void>;
  finish(meetingId: string): Promise<void>;
}

const fileName = (meetingId: string) => `${encodeURIComponent(meetingId)}.json`;

export class PendingUploads {
  private replaying = false;

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Keeps what a stop couldn't save (merged with anything already pending for the meeting). */
  add(meetingId: string, appUrl: string, segments: TranscriptSegment[], needsFinish: boolean): void {
    if (segments.length === 0 && !needsFinish) return;
    const existing = this.read(meetingId);
    const bySeq = new Map<number, TranscriptSegment>();
    for (const s of [...(existing?.segments ?? []), ...segments]) bySeq.set(s.seq, s);
    this.write({
      meetingId,
      appUrl,
      segments: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
      needsFinish: needsFinish || !!existing?.needsFinish,
      savedAt: this.now(),
    });
    this.log(`pending: kept ${segments.length} unsaved segments for ${meetingId}${needsFinish ? " (and /finish)" : ""}`);
  }

  list(): PendingMeeting[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names.flatMap((n) => {
      const p = this.readFile(join(this.dir, n));
      return p ? [p] : [];
    });
  }

  get count(): number {
    return this.list().length;
  }

  /** Replays everything pending for `api`'s app. Stops at the first network failure (still
   * offline) and keeps the rest; a meeting that's gone (404) or too old is dropped. Returns how
   * many meetings are still pending. */
  async replay(api: ReplayApi): Promise<number> {
    if (this.replaying) return this.count;
    this.replaying = true;
    try {
      for (const p of this.list()) {
        if (this.now() - p.savedAt > MAX_AGE_MS) {
          this.log(`pending: dropped ${p.meetingId} (too old)`);
          this.remove(p.meetingId);
          continue;
        }
        if (p.appUrl !== api.appUrl) continue;
        try {
          let left = p.segments;
          let refused = 0;
          while (left.length) {
            const batch = left.slice(0, REPLAY_BATCH);
            try {
              await api.appendSegments(p.meetingId, batch);
            } catch (error) {
              if (!isPermanentRefusal(error)) throw error;
              // Refused for good: retrying won't help. Drop it, say so, and go on.
              refused += batch.length;
              this.log(`pending: the app refused ${batch.length} segments for ${p.meetingId} (${error instanceof Error ? error.message : String(error)}); dropped them`);
            }
            left = left.slice(REPLAY_BATCH);
            // Keep progress, so a failure halfway doesn't resend what landed.
            this.write({ ...p, segments: left });
          }
          if (refused) this.log(`pending: ${refused} of ${p.segments.length} segments for ${p.meetingId} were refused`);
          if (p.needsFinish) await api.finish(p.meetingId);
          this.remove(p.meetingId);
          this.log(`pending: replayed ${p.segments.length} segments for ${p.meetingId}${p.needsFinish ? " and finished it" : ""}`);
        } catch (error) {
          if (error instanceof ApiError && error.kind === "server" && error.status === 404) {
            this.log(`pending: ${p.meetingId} is gone; dropped its leftovers`);
            this.remove(p.meetingId);
            continue;
          }
          this.log(`pending: replay of ${p.meetingId} failed, will retry (${error instanceof Error ? error.message : String(error)})`);
          break;
        }
      }
    } finally {
      this.replaying = false;
    }
    return this.count;
  }

  private read(meetingId: string): PendingMeeting | undefined {
    return this.readFile(join(this.dir, fileName(meetingId)));
  }

  private readFile(path: string): PendingMeeting | undefined {
    try {
      const o = JSON.parse(readFileSync(path, "utf8")) as PendingMeeting;
      if (typeof o.meetingId !== "string" || typeof o.appUrl !== "string" || !Array.isArray(o.segments)) return undefined;
      return { ...o, needsFinish: !!o.needsFinish, savedAt: typeof o.savedAt === "number" ? o.savedAt : 0 };
    } catch {
      return undefined;
    }
  }

  private write(p: PendingMeeting): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, fileName(p.meetingId));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 });
    renameSync(tmp, path);
  }

  private remove(meetingId: string): void {
    rmSync(join(this.dir, fileName(meetingId)), { force: true });
  }
}
