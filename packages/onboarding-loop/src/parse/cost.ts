/**
 * Cost (design 4.9): the harness's own cumulative figure when it reports
 * one (Claude's total_cost_usd is cumulative per process, so the last
 * resume's value wins and nothing is summed across resumes; OpenCode's
 * per-step `cost` is summed within a process), else tokens times a dated
 * price table, else null with source none (Cursor).
 */
import type {
  HarnessName,
  NormalizedEvent,
  RunCost,
  Signal,
  TokenCounts,
} from "../types";

/** USD per million tokens. Rows without a verified price are absent: the cost is then null and the tokens still recorded. */
export const PRICE_TABLE: {
  asOf: string;
  prices: Record<string, { input: number; output: number; cacheRead?: number }>;
} = {
  asOf: "2026-10-23",
  prices: {
    // OpenCode Zen list (FACTS, models.dev provider `opencode`, checked 2026-10-23).
    "opencode/glm-5.3": { input: 1.4, output: 4.4 },
    "opencode/glm-5.2": { input: 1.4, output: 4.4 },
    "opencode/glm-5.1": { input: 1.4, output: 4.4 },
    "opencode/glm-5": { input: 1, output: 3.2 },
    "opencode/glm-5.3-flash": { input: 0.15, output: 0.5 },
    "opencode/glm-4.7": { input: 0.6, output: 2.2 },
    "opencode/glm-4.6": { input: 0.6, output: 2.2 },
    // TODO(loop): gpt-5.3-codex and claude-sonnet-5-5 list prices, verified against the vendors' pages, before the first measured Codex and Hermes rows.
  },
};

function addTokens(into: TokenCounts, more: TokenCounts | undefined): void {
  if (!more) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (more[key] !== undefined) into[key] = (into[key] ?? 0) + more[key];
  }
}

/** Tokens over the run: each process's result events summed (Claude reports per-process cumulative usage on the result, so one per process). */
export function sumTokens(
  events: NormalizedEvent[],
  harness: HarnessName,
): TokenCounts {
  const total: TokenCounts = {};
  if (harness === "opencode") {
    // Each step_finish carries that step's tokens: sum the turn_end events, skip the duplicate result events.
    for (const event of events)
      if (event.kind === "turn_end") addTokens(total, event.tokens);
    return total;
  }
  for (const event of events)
    if (event.kind === "result") addTokens(total, event.tokens);
  return total;
}

/** USD from tokens and the table; null when the model has no row. */
export function priceTokens(
  model: string | null,
  tokens: TokenCounts,
): number | null {
  if (!model) return null;
  const row = PRICE_TABLE.prices[model];
  if (!row) return null;
  const input = ((tokens.input ?? 0) / 1e6) * row.input;
  const cached =
    ((tokens.cacheRead ?? 0) / 1e6) * (row.cacheRead ?? row.input * 0.1);
  const output = ((tokens.output ?? 0) / 1e6) * row.output;
  return Math.round((input + cached + output) * 10000) / 10000;
}

/**
 * The run's cost. `events` is every process's events in order; processes
 * are told apart by the `processIndex` the driver stamps on the raw line,
 * or, lacking that, treated as one.
 */
export function computeCost(
  harness: HarnessName,
  signal: Signal,
  model: string | null,
  eventsByProcess: NormalizedEvent[][],
): RunCost {
  const all = eventsByProcess.flat();
  const tokens = sumTokens(all, harness);
  if (signal.cost === "harness") {
    let usd = 0;
    let any = false;
    for (const events of eventsByProcess) {
      if (harness === "opencode") {
        for (const event of events)
          if (event.kind === "turn_end" && event.costUsd !== undefined) {
            usd += event.costUsd;
            any = true;
          }
      } else {
        // Cumulative per process: the last result event's figure.
        const last = [...events]
          .reverse()
          .find(
            (event) => event.kind === "result" && event.costUsd !== undefined,
          );
        if (last?.costUsd !== undefined) {
          usd += last.costUsd;
          any = true;
        }
      }
    }
    return {
      usd: any ? Math.round(usd * 10000) / 10000 : null,
      source: "harness",
      tokens,
      model,
    };
  }
  if (signal.cost === "tokens_x_list") {
    return {
      usd: priceTokens(model, tokens),
      source: "tokens_x_list",
      tokens,
      model,
    };
  }
  return { usd: null, source: "none", tokens, model };
}

/** The model the harness itself named, from the first event that carries one. */
export function resolvedModel(events: NormalizedEvent[]): string | null {
  for (const event of events) if (event.model) return event.model;
  return null;
}
