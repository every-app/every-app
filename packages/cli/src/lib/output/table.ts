/**
 * Aligned blocks for a person's screen: labelled facts (`Live  https://…`)
 * and tables with a dim header row, like `gh`'s. Cells may carry color;
 * widths count what shows.
 */
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { wrap } from "./wrap";

const width = (text: string) => stripVTControlCharacters(text).length;
const pad = (text: string, to: number) => text + " ".repeat(to - width(text));

/** A labelled value in a block of them (`Live  https://…`). */
export interface Fact {
  label: string;
  value: string;
}

/**
 * Each fact on its line, the values lined up after dim labels. With
 * `columns`, a value too long for the line goes on under its start.
 */
export function formatFacts(facts: readonly Fact[], columns?: number): string[] {
  const labels = Math.max(...facts.map((fact) => fact.label.length));
  const under = " ".repeat(labels + 2);
  return facts.flatMap((fact) =>
    (columns === undefined ? [fact.value] : wrap(fact.value, columns - under.length)).map((line, index) =>
      index === 0 ? `${chalk.dim(fact.label.padEnd(labels))}  ${line}` : `${under}${line}`,
    ),
  );
}

/** A dim header row, then one row per entry, columns two spaces apart. */
export function formatTable(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string[] {
  const widths = header.map((title, column) =>
    Math.max(width(title), ...rows.map((row) => width(row[column] ?? ""))),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : pad(cell, widths[column]!),
      )
      .join("  ");
  return [chalk.dim(line(header)), ...rows.map(line)];
}
