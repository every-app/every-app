/**
 * What every adapter's normalizer needs: a JSON line parser that never
 * throws, a shell-ish argv splitter for the commands a tool ran, and the
 * one way to build a NormalizedEvent so the shape stays identical across
 * harnesses (design 4.4).
 */
import type { NormalizedEvent, NormalizedEventKind } from "../types";

/** One stream line as JSON, or null when it is not JSON (a banner, a stderr warning, a blank). */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * A command string split the way a shell would for the common cases: spaces
 * separate words, single and double quotes group, a backslash escapes. Good
 * enough to find `everyapp setup --domain …` in it; nothing executes this.
 */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasWord = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[++i];
      hasWord = true;
    } else if (/\s/.test(ch)) {
      if (hasWord) {
        words.push(current);
        current = "";
        hasWord = false;
      }
    } else {
      current += ch;
      hasWord = true;
    }
  }
  if (hasWord) words.push(current);
  return words;
}

/** Milliseconds since the epoch or an ISO string to ISO; undefined when neither. */
export function toIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

/** The text of a tool result as harnesses deliver it: a string, or content blocks with text. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) ? (str(block["text"]) ?? "") : ""))
      .join("");
  }
  if (isRecord(content)) return str(content["text"]) ?? "";
  return "";
}

/** The one constructor, so every adapter emits the same shape. */
export function event(
  kind: NormalizedEventKind,
  receivedAt: string,
  raw: unknown,
  fields: Omit<Partial<NormalizedEvent>, "kind" | "receivedAt" | "raw"> = {},
): NormalizedEvent {
  const out: NormalizedEvent = { receivedAt, kind, raw };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined)
      (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** The command line as a person would type it, for the record's `harness.commandLine`. */
export function commandLineString(argv: string[]): string {
  return argv
    .map((word) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
        ? word
        : `'${word.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}
