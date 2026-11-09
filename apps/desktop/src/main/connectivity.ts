// Whether Every App can reach its app: `online`, `offline` or `signin-needed` (src/shared/ipc.ts
// `Connection`). Fed by every /api/v1 call's outcome, the OS's network state (net.isOnline) and
// wake from sleep. While offline it probes the app with backoff (2 s doubling to 60 s), and a
// network change or wake probes at once. No Electron import: timers and the probe are injected.

import { EventEmitter } from "node:events";
import type { Connection } from "@shared/ipc";
import { ApiError } from "./api/client";

/** What an API outcome says about reachability. */
export type Reachability = "reachable" | "unreachable" | "unknown";

/** Network failures, and the gateway's "can't reach the Worker" answers, mean unreachable. Any
 * other HTTP answer, including an error, proves the app is reachable. Sign-in problems are the
 * auth state's business, not reachability's. */
export function reachabilityOf(error: unknown): Reachability {
  if (error === undefined) return "reachable";
  if (error instanceof ApiError) {
    if (error.kind === "network") return "unreachable";
    if (error.kind === "server" && (error.status === 502 || error.status === 503 || error.status === 504)) return "unreachable";
    if (error.kind === "server" || error.kind === "decoding") return "reachable";
    return "unknown";
  }
  // fetch itself throws a TypeError ("fetch failed") when the network is down, e.g. in a token
  // refresh, which doesn't go through ApiClient.
  if (error instanceof TypeError) return "unreachable";
  return "unknown";
}

export interface ConnectivityOptions {
  /** Checks the app (e.g. GET /api/v1/me); resolves with the outcome's error, or undefined. */
  probe: () => Promise<unknown>;
  /** Whether anyone is signed in; nothing is probed while signed out. */
  signedIn: () => boolean;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export class Connectivity extends EventEmitter<{ change: [Connection] }> {
  private reachable = true;
  private osOnline = true;
  private signInNeeded = false;
  private current: Connection = "online";
  private timer: unknown;
  private backoff: number;
  private probing = false;

  constructor(private readonly options: ConnectivityOptions) {
    super();
    this.backoff = options.initialBackoffMs ?? 2000;
  }

  get state(): Connection {
    return this.current;
  }

  /** Every API call reports here (error undefined on success). */
  report(error?: unknown): void {
    const r = reachabilityOf(error);
    if (r === "reachable") this.setReachable(true);
    else if (r === "unreachable") this.setReachable(false);
  }

  /** The OS's own network state (net.isOnline). Coming back online probes at once. */
  setOsOnline(online: boolean): void {
    if (online === this.osOnline) return;
    this.osOnline = online;
    if (online && !this.reachable) this.probeSoon(0);
    this.update();
  }

  /** Woke from sleep: whatever we thought, check again. */
  resumed(): void {
    if (!this.reachable) this.probeSoon(0);
  }

  /** The sign-in expired or Access wants a login: overrides online/offline. */
  setSignInNeeded(needed: boolean): void {
    this.signInNeeded = needed;
    this.update();
  }

  /** Signed out on purpose: forget everything and stop probing. */
  reset(): void {
    this.cancelProbe();
    this.reachable = true;
    this.signInNeeded = false;
    this.backoff = this.options.initialBackoffMs ?? 2000;
    this.update();
  }

  stop(): void {
    this.cancelProbe();
  }

  private setReachable(reachable: boolean): void {
    if (reachable) {
      this.cancelProbe();
      this.backoff = this.options.initialBackoffMs ?? 2000;
    } else if (this.reachable || this.timer === undefined) {
      this.probeSoon(this.backoff);
    }
    if (reachable !== this.reachable) this.options.log?.(reachable ? "connection: the app is reachable again" : "connection: the app is unreachable");
    this.reachable = reachable;
    this.update();
  }

  private probeSoon(ms: number): void {
    this.cancelProbe();
    const set = this.options.setTimer ?? ((fn, t) => setTimeout(fn, t));
    this.timer = set(() => {
      this.timer = undefined;
      void this.runProbe();
    }, ms);
  }

  private async runProbe(): Promise<void> {
    if (this.probing || !this.options.signedIn()) return;
    this.probing = true;
    let error: unknown;
    try {
      error = await this.options.probe();
    } catch (e) {
      error = e;
    } finally {
      this.probing = false;
    }
    if (reachabilityOf(error) === "reachable") return this.setReachable(true);
    // Still down (or unknown): try again later, backing off.
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 60_000);
    if (!this.reachable) this.probeSoon(this.backoff);
  }

  private cancelProbe(): void {
    if (this.timer !== undefined) (this.options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
  }

  private update(): void {
    const next: Connection = this.signInNeeded ? "signin-needed" : this.reachable && this.osOnline ? "online" : "offline";
    if (next === this.current) return;
    this.current = next;
    this.emit("change", next);
  }
}
