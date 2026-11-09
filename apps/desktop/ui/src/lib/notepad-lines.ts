/**
 * How the notepad draws each Markdown line behind its textarea. Every part keeps its exact
 * characters (only color and decoration change, never width), so the textarea's caret and
 * wrapping line up with what's drawn.
 */
export type LinePart =
  | { kind: "text"; text: string }
  /** Leading spaces. */
  | { kind: "indent"; text: string }
  /** "-" or "*": drawn as a dot over the hidden character. */
  | { kind: "bullet"; text: string }
  /** "1." and the like, "#", "##", "[ ]", "[x]": drawn quieter. */
  | { kind: "marker"; text: string }
  /** The text of a checked task. */
  | { kind: "done"; text: string }
  /** The text of a heading. */
  | { kind: "heading"; text: string };

const LIST = /^(\s*)([-*]|\d+[.)])(\s+)(?:(\[[ xX]\])(\s+))?(.*)$/;
const HEADING = /^(#{1,6})(\s+)(.*)$/;

export function parseLine(line: string): LinePart[] {
  const list = LIST.exec(line);
  if (list) {
    const [, indent = "", marker = "", gap = "", box, boxGap = "", rest = ""] =
      list;
    const parts: LinePart[] = [];
    if (indent) parts.push({ kind: "indent", text: indent });
    parts.push(
      marker === "-" || marker === "*"
        ? { kind: "bullet", text: marker }
        : { kind: "marker", text: marker },
    );
    parts.push({ kind: "text", text: gap });
    if (box) {
      parts.push({ kind: "marker", text: box });
      parts.push({ kind: "text", text: boxGap });
      if (rest)
        parts.push({
          kind: box.toLowerCase() === "[x]" ? "done" : "text",
          text: rest,
        });
    } else if (rest) {
      parts.push({ kind: "text", text: rest });
    }
    return parts;
  }
  const heading = HEADING.exec(line);
  if (heading) {
    const [, hashes = "", gap = "", rest = ""] = heading;
    const parts: LinePart[] = [
      { kind: "marker", text: hashes },
      { kind: "text", text: gap },
    ];
    if (rest) parts.push({ kind: "heading", text: rest });
    return parts;
  }
  return line ? [{ kind: "text", text: line }] : [];
}
