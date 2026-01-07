import chalk from "chalk";

/**
 * Log a message only when verbose mode is enabled.
 * The message is displayed in dim style for consistency.
 *
 * @param verbose - Whether verbose mode is enabled
 * @param message - The message to log
 */
export function verboseLog(verbose: boolean, message: string): void {
  if (verbose) {
    console.log(chalk.dim(message));
  }
}

/**
 * Log multiple lines only when verbose mode is enabled.
 * Each line is displayed in dim style.
 *
 * @param verbose - Whether verbose mode is enabled
 * @param lines - The lines to log
 */
export function verboseLogLines(verbose: boolean, ...lines: string[]): void {
  if (verbose) {
    lines.forEach((line) => console.log(chalk.dim(line)));
  }
}
