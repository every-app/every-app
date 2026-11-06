/**
 * How a person runs everyapp, for the commands it suggests: `pnpm
 * everyapp` (or `npx`, `yarn`) when a package manager started it — the
 * checkout's and an app's devDependency, run as `pnpm everyapp` or through
 * a script — and plain `everyapp` when it was run directly (installed or
 * linked globally). Package managers set npm_config_user_agent for what
 * they run; nothing else does.
 */
export function invocation(env: NodeJS.ProcessEnv = process.env): string {
  const agent = env["npm_config_user_agent"]?.split("/")[0];
  return agent ? (RUNNERS[agent] ?? "everyapp") : "everyapp";
}

const RUNNERS: Readonly<Record<string, string>> = {
  pnpm: "pnpm everyapp",
  npm: "npx everyapp",
  yarn: "yarn everyapp",
};

/** The invocation every suggested command starts with (`data.rerun`, `data.next`, messages). */
export const CLI = invocation();

/**
 * This run's command, to run again: its arguments as given (`--json`
 * included when this run had it, so an agent runs it as it is), and with
 * `flags` it doesn't have yet. A `terminal` rerun is one only a person at a
 * terminal can do (every `needsTerminal`): it leaves `--json` out, since
 * with it the run would stop at the same place again.
 */
export function thisCommand(
  flags: readonly string[] = [],
  {
    terminal = false,
    argv = process.argv.slice(2),
  }: { terminal?: boolean; argv?: readonly string[] } = {},
): string {
  const args = terminal ? argv.filter((arg) => arg !== "--json") : [...argv];
  for (const flag of flags) {
    if (!args.includes(flag)) args.push(flag);
  }
  return [CLI, ...args.map(quote)].join(" ");
}

/** `argv` without `flag` and its value (`--gateway x`, `--gateway=x`); a flag after it isn't its value. */
function argsWithout(flag: string, argv: readonly string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) {
      if (!argv[i + 1]?.startsWith("-")) i++;
    } else if (!arg.startsWith(`${flag}=`)) args.push(arg);
  }
  return args;
}

/** This run's command without `flag` and its value. */
export function thisCommandWithout(
  flag: string,
  argv: readonly string[] = process.argv.slice(2),
): string {
  return thisCommand([], { argv: argsWithout(flag, argv) });
}

/** This run's command with `flags` in place of whatever it had of `replaced`, in either spelling. */
export function thisCommandInstead(
  replaced: readonly string[],
  flags: readonly string[],
  argv: readonly string[] = process.argv.slice(2),
): string {
  const args = replaced.reduce<readonly string[]>((kept, flag) => argsWithout(flag, kept), argv);
  return [CLI, ...[...args, ...flags].map(quote)].join(" ");
}

/** An argument as a POSIX shell reads it back. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
