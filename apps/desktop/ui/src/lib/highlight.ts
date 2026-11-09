/**
 * Splits a search snippet into plain and matched parts. The server's ranges are [start, end)
 * UTF-16 offsets; out-of-order, overlapping or out-of-bounds ones are tidied, never trusted
 * blindly. The text is only ever rendered as text.
 */
export interface SnippetPart {
  text: string;
  match: boolean;
}

export function snippetParts(
  text: string,
  ranges: readonly { start: number; end: number }[],
): SnippetPart[] {
  const clean = ranges
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(text.length, Math.floor(start))),
      end: Math.max(0, Math.min(text.length, Math.floor(end))),
    }))
    .filter(
      (r) =>
        Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start,
    )
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of clean) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const r of merged) {
    if (r.start > at)
      parts.push({ text: text.slice(at, r.start), match: false });
    parts.push({ text: text.slice(r.start, r.end), match: true });
    at = r.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
