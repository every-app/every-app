/**
 * Fractional indexing utilities for ordering todos.
 *
 * Sort keys are strings that can be compared lexicographically to determine order.
 * The list is sorted in DESCENDING order, meaning:
 * - Higher sort keys appear at the TOP of the list
 * - Lower sort keys appear at the BOTTOM of the list
 *
 * Key generation strategies:
 * - New todos: timestamp-based keys (ensures newer = higher = appears at top)
 * - Insert before a key: prepend "!" (always lexicographically smaller)
 * - Insert after a key: append "~" (always lexicographically greater)
 * - Insert between two keys: find midpoint or extend with middle char
 */

// Counter to ensure uniqueness within the same millisecond
let counter = 0;
let lastTimestamp = 0;

/**
 * Generate a sort key for new todos that appears at the top of the list.
 * Uses timestamp-based approach to ensure each new todo has a unique, increasing sort key.
 */
export function generateDefaultSortKey(): string {
  const timestamp = Date.now();

  // Handle multiple calls within the same millisecond
  if (timestamp !== lastTimestamp) {
    counter = 0;
    lastTimestamp = timestamp;
  } else {
    counter++;
  }

  // Base36 encoding gives lexicographically increasing keys for increasing timestamps
  return (timestamp + counter).toString(36);
}

/**
 * Generate a sort key between two existing sort keys.
 *
 * @param before - Key that should come BEFORE the new key (lower in DESC order)
 * @param after - Key that should come AFTER the new key (higher in DESC order)
 * @returns A sort key that will be ordered between before and after
 *
 * Note: Despite the parameter names, `before < newKey < after` lexicographically.
 * In a DESC-sorted list, `after` appears above `before`.
 */
export function generateSortKeyBetween(
  before?: string,
  after?: string,
): string {
  // No bounds: generate a new default key
  if (!before && !after) {
    return generateDefaultSortKey();
  }

  // Only upper bound: generate key below it (for bottom of list)
  if (!before) {
    return "!" + after;
  }

  // Only lower bound: generate key above it (for top of list)
  if (!after) {
    return before + "~";
  }

  // Both bounds: find a key between them
  return generateKeyBetween(before, after);
}

/**
 * Generate a key lexicographically between two keys where before < after.
 */
function generateKeyBetween(before: string, after: string): string {
  // Find first position where strings differ
  const minLen = Math.min(before.length, after.length);
  let i = 0;
  while (i < minLen && before[i] === after[i]) {
    i++;
  }

  // Common prefix
  const prefix = before.substring(0, i);

  // Case 1: before is a prefix of after (e.g., "a" and "ab")
  if (i === before.length) {
    // Insert between "" and after[i] by using a char in between
    const afterChar = after.charCodeAt(i);
    // Use midpoint between 0 and afterChar, but at least '!' (33) for printability
    const midCode = Math.max(33, Math.floor(afterChar / 2));
    return prefix + String.fromCharCode(midCode);
  }

  // Case 2: after is a prefix of before (shouldn't happen if before < after, but handle it)
  if (i === after.length) {
    return "!" + after;
  }

  // Case 3: strings differ at position i
  const beforeChar = before.charCodeAt(i);
  const afterChar = after.charCodeAt(i);

  // If there's room between the characters, use the midpoint
  if (afterChar - beforeChar > 1) {
    const midCode = Math.floor((beforeChar + afterChar) / 2);
    return prefix + String.fromCharCode(midCode);
  }

  // Characters are adjacent - extend the before string with a middle character
  // This gives us: before < before + "n" < after (assuming before + "n" < after)
  return before + "n";
}
