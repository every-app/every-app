/**
 * Text kept inside the terminal for a person's screen: a sentence longer
 * than the line breaks at a space, so what follows can stay lined up under
 * it. Widths count what shows; color isn't counted.
 */
import { stripVTControlCharacters } from "node:util";

/** The widest a line of prose reads well, however wide the terminal is. */
const WIDEST = 100;

/** The columns prose is wrapped to: the terminal's, {@link WIDEST} at most; 80 when stdout isn't a terminal. */
export function proseWidth(): number {
  return Math.min(process.stdout.columns ?? 80, WIDEST);
}

/** `text` in lines of at most `width` columns, broken at its spaces; a longer word has a line to itself. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let length = 0;
  for (const word of text.split(" ")) {
    const shown = stripVTControlCharacters(word).length;
    if (line && length + 1 + shown > width) {
      lines.push(line);
      line = "";
    }
    length = line ? length + 1 + shown : shown;
    line = line ? `${line} ${word}` : word;
  }
  return [...lines, line];
}
