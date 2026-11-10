/**
 * Numbered steps for a person's screen: each wrapped to the terminal under
 * its number, and its links on lines of their own below it, where a
 * terminal links a URL cleanly and the sentence stays readable. One link is
 * the URL alone; several are labelled. Steps of more than one line get a
 * blank line between them, like a loose list.
 */
import chalk from "chalk";
import { wrap } from "./wrap";

/** A place a step sends the person to, or a value it has them copy. */
export interface StepLink {
  label: string;
  url: string;
}

/** A space in a step's sentence that no line breaks at, so a command stays whole; it is drawn as a plain space. */
export const KEPT_SPACE = String.fromCharCode(0xa0);

/** One step: its sentence (it may carry color and {@link KEPT_SPACE}), and the links under it. */
export interface Step {
  text: string;
  links?: readonly StepLink[];
}

export function formatSteps(steps: readonly Step[], width: number): string[] {
  const blocks = steps.map(({ text, links = [] }, index) => {
    const number = `${index + 1}. `;
    const under = " ".repeat(number.length);
    const labels = Math.max(0, ...links.map((link) => link.label.length));
    return [
      ...wrap(text, width - number.length).map(
        (line, at) => `${at === 0 ? number : under}${line.replaceAll(KEPT_SPACE, " ")}`,
      ),
      ...links.map(
        (link) =>
          `${under}${links.length > 1 ? `${chalk.dim(link.label.padEnd(labels))}  ` : ""}${chalk.cyan(link.url)}`,
      ),
    ];
  });
  const loose = blocks.some((block) => block.length > 1);
  return blocks.flatMap((block, index) => (loose && index > 0 ? ["", ...block] : block));
}
