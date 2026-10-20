/**
 * Aligned blocks for a person's screen: labelled facts (`Live  https://…`)
 * and tables with a dim header row, like `gh`'s. Cells may carry color;
 * widths count what shows.
 */
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";

const width = (text: string) => stripVTControlCharacters(text).length;
const pad = (text: string, to: number) => text + " ".repeat(to - width(text));

/** Each `{ label, value }` on its line, the values lined up after dim labels. */
export function formatFacts(
  facts: ReadonlyArray<{ label: string; value: string }>,
): string[] {
  const labels = Math.max(...facts.map((fact) => fact.label.length));
  return facts.map(
    (fact) => `${chalk.dim(fact.label.padEnd(labels))}  ${fact.value}`,
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
