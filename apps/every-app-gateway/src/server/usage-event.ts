/**
 * One provider call an organization's app made through the gateway, as the
 * AppGateway entrypoint reports it for counting (repositories/UsageRepository.ts).
 * Counts only: never the prompt, the body or a key.
 */
export interface UsageEvent {
  /** The organization the call was attributed to. */
  organizationId: string;
  /** `apps.id` of the calling app (the platform organization's row for a shared app). */
  appRowId: string;
  /** The user behind the call, or '' when it was the app's own. */
  userId: string;
  kind: "ai" | "capability";
  /** The AI provider id (the one the call went to, never `default`), or the capability id. */
  target: string;
  /**
   * For an AI call, the model the request named (or the default the
   * Gateway filled in), as the provider names it: counted per model in
   * `usage_models` beside the provider's row. Absent when the proxy
   * read none (a route it streams through unread).
   */
  model?: string;
  /**
   * 1 when this is the call itself, reported the moment the provider
   * answered (its headers arrived): the provider bills from there, however
   * the body is read afterwards. 0 when it adds what was read off the body
   * later (tokens, a cost), to a call already counted.
   */
  calls: 0 | 1;
  /** The provider's answer; 400 and above counts as a failure (for the call, not for a later addition). */
  status: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported cost in millionths of a US dollar. */
  costMicros?: number;
  /** When the call happened; now by default. */
  at?: Date;
}

export interface UsageRecorder {
  record(event: UsageEvent): Promise<void>;
}

/** A provider-reported cost in US dollars as whole millionths (never negative). */
export function dollarsToMicros(cost: number | null | undefined): number {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return 0;
  return Math.max(0, Math.round(cost * 1_000_000));
}

/** UTC "YYYY-MM-DD" and "YYYY-MM" of an instant. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function utcMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}
