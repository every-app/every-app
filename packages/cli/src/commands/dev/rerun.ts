import { thisCommand } from "@/lib/output/command";

/**
 * This run's command with `flag` set to `value`: any value it was given
 * (`--base-host x`, `--base-host=x`, or the camelCase spelling) replaced.
 */
export function replaceFlag(
  flag: `--${string}`,
  value: string,
  argv: readonly string[] = process.argv.slice(2),
): string {
  const camel = flag
    .slice(2)
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const spellings = new Set([flag, `--${camel}`]);
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (spellings.has(arg)) {
      i++;
      continue;
    }
    if ([...spellings].some((spelling) => arg.startsWith(`${spelling}=`))) continue;
    args.push(arg);
  }
  return thisCommand([], [...args, flag, value]);
}
