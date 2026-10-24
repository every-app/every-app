import type { ReactNode } from "react";

/**
 * An email address in running text, kept whole. The hyphen in
 * "someone-else@example.com" is a line-break opportunity, so a browser splits
 * it there; as an atomic inline the address moves to the next line in one
 * piece and only breaks inside when it is wider than the line by itself
 * (`white-space: nowrap` would overflow the card instead). The punctuation
 * right after it (`after`) stays with it, so a comma never starts a line.
 */
export function Address({
  children,
  after,
}: {
  children: string;
  after?: string;
}) {
  return (
    <span className="inline-block max-w-full wrap-anywhere">
      <strong className="font-medium text-foreground">{children}</strong>
      {after}
    </span>
  );
}

// An address and the punctuation right after it. A dot only counts as
// punctuation when no label follows it, so "x@acme.com." at the end of a
// sentence keeps its full-stop out of the address.
const ADDRESS = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)([,.;:!?]?)/g;

/** `text` with every email address in it rendered as an Address. */
export function withAddresses(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const [whole, address = "", after = ""] = match;
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <Address key={start} after={after || undefined}>
        {address}
      </Address>,
    );
    last = start + whole.length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
