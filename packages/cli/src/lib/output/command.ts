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

/** This run's command without `flag` and its value (`--gateway x`, `--gateway=x`). */
export function thisCommandWithout(
  flag: string,
  argv: readonly string[] = process.argv.slice(2),
): string {
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) i++;
    else if (!arg.startsWith(`${flag}=`)) args.push(arg);
  }
  return thisCommand([], args);
}

/** An argument as a POSIX shell reads it back. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
