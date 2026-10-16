/**
 * The command to run next, as a person types it or an agent runs it
 * (`data.rerun` on errors and actions). While publishing is paused
 * (.github/RELEASE.md) everyapp runs from the checkout as `pnpm everyapp`.
 */
export const CLI = "pnpm everyapp";

/**
 * This run's command, to run again: its arguments as given, without
 * `--json` (an agent adds its own), and with `flags` it doesn't have yet.
 */
export function thisCommand(
  flags: readonly string[] = [],
  argv: readonly string[] = process.argv.slice(2),
): string {
  const args = argv.filter((arg) => arg !== "--json");
  for (const flag of flags) {
    if (!args.includes(flag)) args.push(flag);
  }
  return [CLI, ...args.map(quote)].join(" ");
}

/** An argument as a POSIX shell reads it back. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
