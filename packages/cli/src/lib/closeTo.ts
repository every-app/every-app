/**
 * The name a person most likely meant, for an error's "Did you mean …?":
 * never an unrelated word.
 */

/** Within two edits of `input`: a typo worth suggesting, not an unrelated word. */
export function closeTo(input: string, candidates: readonly string[]): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

/** The fewest letters of a name that say which one is meant. */
const SHORTEST_PART = 3;

/**
 * The candidate that holds `input` (`google` is `google-workspace`): one
 * that starts with it before one that has it inside, the shortest of
 * those. Else a typo's match ({@link closeTo}).
 */
export function closestTo(input: string, candidates: readonly string[]): string | undefined {
  const part = input.toLowerCase();
  if (part.length < SHORTEST_PART) return closeTo(input, candidates);
  const holding = candidates
    .filter((candidate) => candidate.toLowerCase().includes(part))
    .sort(
      (a, b) =>
        Number(b.toLowerCase().startsWith(part)) - Number(a.toLowerCase().startsWith(part)) || a.length - b.length,
    );
  return holding[0] ?? closeTo(input, candidates);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
