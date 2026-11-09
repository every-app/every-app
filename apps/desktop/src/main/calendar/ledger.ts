// Which meeting prompts have already been shown, kept across restarts (userData/prompts.json) so
// a relaunch doesn't prompt again for the same meeting. Ids are the planner's
// `meeting.<eventId>.<startSec>` / `started.<eventId>.<startSec>`, so a moved meeting gets a new
// prompt. Entries for meetings that started over a day ago are dropped. No Electron import.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const KEEP_MS = 24 * 60 * 60_000;

/** The event id and start (ms) inside a prompt id, or undefined for another kind of id. */
export function parsePromptId(id: string): { kind: "meeting" | "started"; eventId: string; startMs: number } | undefined {
  const first = id.indexOf(".");
  const last = id.lastIndexOf(".");
  if (first <= 0 || last <= first) return undefined;
  const kind = id.slice(0, first);
  if (kind !== "meeting" && kind !== "started") return undefined;
  const startSec = Number(id.slice(last + 1));
  if (!Number.isFinite(startSec)) return undefined;
  return { kind, eventId: id.slice(first + 1, last), startMs: startSec * 1000 };
}

export class PromptLedger {
  readonly delivered = new Set<string>();
  readonly nudged = new Set<string>();

  /** An empty `path` keeps it in memory only. */
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  load(): this {
    try {
      const o = JSON.parse(readFileSync(this.path, "utf8")) as { delivered?: unknown; nudged?: unknown };
      for (const [list, set] of [
        [o.delivered, this.delivered],
        [o.nudged, this.nudged],
      ] as const) {
        if (Array.isArray(list)) for (const id of list) if (typeof id === "string" && this.fresh(id)) set.add(id);
      }
    } catch {
      // Nothing saved yet, or unreadable: start empty.
    }
    return this;
  }

  markDelivered(id: string): void {
    this.delivered.add(id);
    this.save();
  }

  markNudged(id: string): void {
    this.nudged.add(id);
    this.save();
  }

  private fresh(id: string): boolean {
    const parsed = parsePromptId(id);
    return !!parsed && parsed.startMs > this.now() - KEEP_MS;
  }

  private save(): void {
    for (const set of [this.delivered, this.nudged]) for (const id of set) if (!this.fresh(id)) set.delete(id);
    if (!this.path) return; // in memory only
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ delivered: [...this.delivered], nudged: [...this.nudged] }), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // Not important: at worst a prompt repeats after a restart.
    }
  }
}
