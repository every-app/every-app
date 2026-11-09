/**
 * Markdown shortcuts for a plain textarea: Enter continues a list (or ends
 * it on an empty item), Tab and Shift+Tab indent a list item, ⌘B and ⌘I
 * wrap the selection. Each returns an edit: replace [from, to) with `text`
 * and put the caret (or selection) at [selStart, selEnd].
 */
export interface Edit {
  from: number;
  to: number;
  text: string;
  selStart: number;
  selEnd: number;
}

export interface KeyInput {
  key: string;
  shift: boolean;
  meta: boolean;
}

const LIST = /^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?/;
const INDENT = "  ";

function lineStart(value: string, at: number): number {
  return value.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(value: string, at: number): number {
  const end = value.indexOf("\n", at);
  return end === -1 ? value.length : end;
}

export function markdownShortcut(
  value: string,
  start: number,
  end: number,
  input: KeyInput,
): Edit | null {
  if (input.meta && (input.key === "b" || input.key === "i")) {
    const mark = input.key === "b" ? "**" : "_";
    const selected = value.slice(start, end);
    return {
      from: start,
      to: end,
      text: `${mark}${selected}${mark}`,
      selStart: start + mark.length,
      selEnd: end + mark.length,
    };
  }
  if (input.meta) return null;

  const from = lineStart(value, start);
  const line = value.slice(from, lineEnd(value, start));
  const list = LIST.exec(line);

  if (input.key === "Enter" && !input.shift && start === end && list) {
    const prefix = list[0];
    // Only when the caret is past the marker.
    if (start - from < prefix.length) return null;
    if (line.trim() === prefix.trim()) {
      // An empty item ends the list: clear its marker.
      return {
        from,
        to: from + line.length,
        text: "",
        selStart: from,
        selEnd: from,
      };
    }
    const [, indent = "", marker = "-", task] = list;
    const numbered = /^(\d+)\.$/.exec(marker);
    const nextMarker = numbered ? `${Number(numbered[1]) + 1}.` : marker;
    const text = `\n${indent}${nextMarker} ${task ? "[ ] " : ""}`;
    return {
      from: start,
      to: end,
      text,
      selStart: start + text.length,
      selEnd: start + text.length,
    };
  }

  if (input.key === "Tab" && list) {
    if (input.shift) {
      const remove = line.startsWith(INDENT)
        ? INDENT.length
        : line.startsWith(" ")
          ? 1
          : 0;
      if (!remove)
        return {
          from: start,
          to: end,
          text: value.slice(start, end),
          selStart: start,
          selEnd: end,
        };
      return {
        from,
        to: from + remove,
        text: "",
        selStart: Math.max(from, start - remove),
        selEnd: Math.max(from, end - remove),
      };
    }
    return {
      from,
      to: from,
      text: INDENT,
      selStart: start + INDENT.length,
      selEnd: end + INDENT.length,
    };
  }

  return null;
}
