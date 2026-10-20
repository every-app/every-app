/** "1 app", "3 apps". */
export const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "a deploy of todo" → "A deploy of todo". */
export const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** A non-empty string from event data, else undefined. */
export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** A non-empty string from a database row, else null. */
export const textOrNull = (value: unknown): string | null => text(value) ?? null;

/**
 * The last 20 non-blank lines of a child's output, the outputs joined in
 * order (stdout then stderr): what a failure shows of it.
 */
export function outputTail(...outputs: string[]): string[] {
  return outputs
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-20);
}

/** "a", "a and b", "a, b and c". */
export function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A list of strings from event data, else empty. */
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];
