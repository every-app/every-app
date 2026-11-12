/**
 * A command's result as a person reads it (docs/cli-output.md): a ticked
 * headline saying what happened, then only what they must know or do next
 * in short blocks, one fact per line and each command on a line of its own.
 * The full account is `detail`: shown dim with --verbose, and otherwise
 * held back behind one dim `More: --verbose` line. `--json` gets the whole
 * account as the event's `message`, as it always did.
 */
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { ticked, type EventSink } from "./events";
import { formatFacts, type Fact } from "./table";

interface Result {
  /** What happened, in a few words and without a period: "Removed cloudflare from Acme". */
  headline: string;
  /** False when nothing was done (a link to open, a state to read): the headline without its tick. */
  ticked?: boolean;
  /** What the person must know or do next: blocks of lines, a blank line before each; empty ones are dropped. */
  blocks?: ReadonlyArray<readonly string[]>;
  /** The rest of the account, a sentence per line: with --verbose only. */
  detail?: readonly string[];
  /** `--json`'s message when it isn't the headline and the detail. */
  message?: readonly string[];
  data: Record<string, unknown>;
}

/** Emit `done` for a result: the short form for a person, the whole account for a script. */
export function finish(out: EventSink, result: Result): void {
  const blocks = (result.blocks ?? []).filter((block) => block.length > 0);
  const detail = result.detail ?? [];
  out.emit({
    type: "done",
    message: stripVTControlCharacters((result.message ?? [result.headline, ...detail]).join("\n")),
    display: [result.ticked === false ? result.headline : ticked(result.headline), ...blocks.flatMap((block) => ["", ...block])].join("\n"),
    ...(detail.length > 0 ? { detail: detail.join("\n") } : {}),
    data: result.data,
  });
}

/** Labelled values, lined up; under `title` when there is one (`Left behind:`). */
export function factLines(rows: readonly Fact[], title?: string): string[] {
  if (rows.length === 0) return [];
  const lines = formatFacts(rows);
  return title ? [`${title}:`, ...lines.map((line) => `  ${line}`)] : lines;
}

/**
 * Commands a person may run, each whole on a line so it can be copied: one
 * beside its label (`Undo:  everyapp mcp on x`), several under it.
 */
export function commandLines(label: string, commands: readonly string[]): string[] {
  if (commands.length === 0) return [];
  if (commands.length === 1) return [`${chalk.dim(`${label}:`)}  ${commands[0]}`];
  return [`${label}:`, ...commands.map((command) => `  ${command}`)];
}
