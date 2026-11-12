/**
 * The CLI reference page of the agent docs (cli.md), generated from the
 * commands themselves: every command with its arguments, its own flags and
 * its description, so a new command or flag reaches the docs by the test
 * that compares this to the page. The flags most commands share are listed
 * once at the top instead of under every command.
 */
import type { Command, CommandContext, RouteMap } from "@stricli/core";
import { buildApp } from "@/app";
import { accountFlag, apiFlags, gatewayFlag, jsonFlag, verboseFlag } from "@/commands/flags";
import { CLI } from "@/lib/output/command";
import { plain } from "./pages";

/** The application as the docs read it: nothing to report, no color. */
const app = buildApp({ color: false, args: [], report: () => undefined });

type Target = Command<CommandContext> | RouteMap<CommandContext>;

interface FlagDoc {
  name: string;
  kind: string;
  brief: string;
  placeholder?: string;
  optional: boolean;
  default?: string;
  variadic?: boolean | string;
  hidden?: boolean;
  values?: readonly string[];
}

interface PositionalDoc {
  placeholder: string;
  brief: string;
  optional: boolean;
  list: boolean;
}

interface CommandDoc {
  /** "create", "secret set". */
  path: string;
  brief: string;
  hidden: boolean;
  flags: FlagDoc[];
  positional: PositionalDoc[];
  /** The command's own description (stricli's fullDescription), without color. */
  description: string;
}

const kebab = (flag: string) =>
  flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function flagDocs(command: Command<CommandContext>): FlagDoc[] {
  return Object.entries(command.parameters.flags ?? {}).map(([name, flag]) => {
    const parameter = flag as Record<string, unknown> & { kind: string; brief: string };
    return {
      name: kebab(name),
      kind: parameter.kind,
      brief: parameter.brief,
      placeholder: parameter["placeholder"] as string | undefined,
      optional: Boolean(parameter["optional"]) || parameter["default"] !== undefined,
      default:
        parameter["default"] === undefined ? undefined : String(parameter["default"]),
      variadic: parameter["variadic"] as boolean | string | undefined,
      hidden: Boolean(parameter["hidden"]),
      values: parameter["values"] as readonly string[] | undefined,
    };
  });
}

function positionalDocs(command: Command<CommandContext>): PositionalDoc[] {
  const positional = command.parameters.positional;
  if (!positional) return [];
  if (positional.kind === "array") {
    const parameter = positional.parameter as unknown as Record<string, unknown> & {
      brief: string;
    };
    return [
      {
        placeholder: (parameter["placeholder"] as string | undefined) ?? "arg",
        brief: parameter.brief,
        optional: Boolean(positional["minimum"] === 0 || positional["minimum"] === undefined),
        list: true,
      },
    ];
  }
  return positional.parameters.map((parameter, index) => ({
    placeholder: parameter.placeholder ?? `arg${index + 1}`,
    brief: parameter.brief,
    optional: Boolean(parameter.optional),
    list: false,
  }));
}

/** Every command, depth first, in the order the route maps list them. */
export function commandDocs(): CommandDoc[] {
  const docs: CommandDoc[] = [];
  const visit = (target: Target, path: string[], hidden: boolean) => {
    if ("getAllEntries" in target) {
      // A group's default command (`dev`'s hidden `run`) is documented as
      // the group itself, the way it is typed.
      const runs = target.getDefaultCommand();
      if (runs) push(runs, path, hidden);
      for (const entry of target.getAllEntries()) {
        if (entry.target === runs) continue;
        visit(entry.target, [...path, entry.name.original], hidden || entry.hidden);
      }
      return;
    }
    push(target, path, hidden);
  };
  const push = (target: Command<CommandContext>, path: string[], hidden: boolean) => {
    docs.push({
      path: path.join(" "),
      brief: target.brief,
      hidden,
      flags: flagDocs(target),
      positional: positionalDocs(target),
      description: plain(target.fullDescription ?? ""),
    });
  };
  visit(app.root as unknown as Target, [], false);
  return docs;
}

/** The flags listed once at the top of the page, not under each command: each name with the definitions it shares. */
const SHARED_FLAGS = new Map<string, readonly string[]>([
  ["json", [jsonFlag.brief]],
  ["verbose", [verboseFlag.brief]],
  ["gateway", [gatewayFlag.brief, apiFlags.gateway.brief]],
  ["account-id", [accountFlag.brief]],
]);

/** A flag the top of the page lists: a shared definition, not a flag of the same name with a meaning of its own (`db restore --gateway`). */
const isShared = (flag: FlagDoc) => SHARED_FLAGS.get(flag.name)?.includes(flag.brief) ?? false;

function flagLine(flag: FlagDoc): string {
  const value =
    flag.kind === "boolean" || flag.kind === "counter"
      ? ""
      : flag.values
        ? ` ${flag.values.join("|")}`
        : ` <${flag.placeholder ?? "value"}>`;
  const notes = [
    flag.variadic ? "repeatable" : "",
    flag.optional ? "" : "required",
    flag.default === undefined ? "" : `default \`${flag.default}\``,
    flag.hidden ? "hidden" : "",
  ].filter(Boolean);
  return `- \`--${flag.name}${value}\`${notes.length ? ` (${notes.join(", ")})` : ""}: ${flag.brief.replace(/\n/g, " ")}`;
}

function usage(doc: CommandDoc): string {
  const args = doc.positional.map((arg) => {
    const name = `<${arg.placeholder}>${arg.list ? "..." : ""}`;
    return arg.optional ? `[${name}]` : name;
  });
  return [`${CLI} ${doc.path}`.trim(), ...args].join(" ");
}

/** An Examples heading of a help text (`Examples:`, `EXAMPLES`). */
const EXAMPLES_HEADING = /^\s*examples?:?\s*$/i;

/**
 * A command line of a help text as a shell line: without its `$ ` prompt,
 * and a note after it (`everyapp create my-app      ./my-app, its own
 * repository`) as a `#` comment, so the line runs as copied.
 */
function shellLine(line: string): string {
  const command = line.trim().replace(/^\$ /, "");
  const noted = command.match(/^(.*?\S)\s{2,}(\S.*)$/);
  if (!noted) return command;
  return `${noted[1]}  # ${noted[2]!.replace(/^\((.*)\)$/, "$1")}`;
}

/**
 * A command's description as Markdown: wrapped prose joined into
 * paragraphs, and the command lines (every indented line under an
 * Examples heading, and an indented line that starts with a command
 * elsewhere) as a shell block.
 */
function description(text: string): string[] {
  const out: string[] = [];
  /** An indented line that is a command to type, not wrapped prose. */
  const isCommand = (line: string) =>
    /^ {2}(\$ )?([A-Z][A-Z0-9_]*=\S* )*(everyapp|pnpm|npx|npm|yarn|curl|claude|codex|git|cd|echo|printf|export|cf)( |$)/.test(
      line,
    );
  for (const paragraph of text.trim().split(/\n\s*\n/)) {
    if (!paragraph.trim()) continue;
    // Text runs (a sentence, or a list item with its wrapped lines) and command lines, in order.
    const blocks: Array<{ code: boolean; lines: string[] }> = [];
    let examples = false;
    for (const line of paragraph.split("\n")) {
      const last = blocks.at(-1);
      if (EXAMPLES_HEADING.test(line)) {
        examples = true;
        continue;
      }
      if ((examples && /^\s{2,}\S/.test(line)) || isCommand(line)) {
        if (last?.code) last.lines.push(shellLine(line));
        else blocks.push({ code: true, lines: [shellLine(line)] });
      } else if (/^\s*(\d+\.|[-•])\s/.test(line) || !last || last.code) {
        blocks.push({ code: false, lines: [line.trim()] });
      } else {
        last.lines.push(line.trim());
      }
    }
    for (const block of blocks) {
      if (block.code) {
        out.push("```sh", ...block.lines, "```", "");
        continue;
      }
      const sentence = block.lines.join(" ").replace(/\s+/g, " ").trim();
      if (sentence) out.push(sentence);
    }
    out.push("");
  }
  // List items of one paragraph stay together; a blank line ends each paragraph.
  return out;
}

/** The whole page. */
export function cliReference(): string {
  const docs = commandDocs();
  const out: string[] = [
    "---",
    'title: "CLI reference"',
    'description: "Every everyapp command with its arguments and flags, generated from the CLI itself, plus the exit codes and the flags most commands share."',
    "---",
    "",
    "<!-- Generated from the command definitions by packages/cli/src/docs/cliReference.ts; regenerate with `pnpm -C packages/cli docs:update`. -->",
    "",
    "Install with `npm install -g everyapp`, then run `everyapp …` (in a checkout of the EveryApp repository, `pnpm everyapp …`). Every command takes `--help`. Agents add `--json` and read the events ([the protocol](/docs/agent/json)); codes are on [errors](/docs/agent/errors).",
    "",
    "## Exit codes",
    "",
    "- `0`: done.",
    "- `1`: an `error` event ended the run (a declined prompt, `CANCELLED`, too).",
    "- `2`: stopped on `action_required`: do the action, then run `data.rerun`.",
    "- `130`: Ctrl-C.",
    "- `251`: no such command (`UNKNOWN_COMMAND`).",
    "- `252`: bad arguments (`UNKNOWN_FLAG`, `INVALID_VALUE`, `MISSING_ARGUMENT`, …).",
    "",
    "## Shared flags",
    "",
    "Not repeated under each command below:",
    "",
    "- `--json`: NDJSON events on stdout, never prompts.",
    "- `--verbose`: every step, the detail a result's short form holds back (it then ends `More: --verbose`), the output of what everyapp runs, and stack traces.",
    "- `--no-color`, `-h`/`--help`, `-v`/`--version`.",
    "- `--gateway <url|name>`: which Gateway, when the account holds several (default `EVERYAPP_GATEWAY_URL`). On every command that reaches a Gateway. On the commands that call a Gateway tool (`workspace`, `events`, `ai`, `call`) the default is `EVERYAPP_GATEWAY_URL`, else the Gateway you signed in to with `login --gateway`, else the one your Cloudflare login finds.",
    "- `--account-id <id>`: which Cloudflare account, when the login sees several (default `CLOUDFLARE_ACCOUNT_ID`).",
    "",
    "## Commands",
    "",
  ];
  for (const doc of docs) {
    if (!doc.path) continue;
    const own = doc.flags.filter((flag) => !isShared(flag));
    out.push(
      `### \`${usage(doc)}\`${doc.hidden ? " (hidden)" : ""}`,
      `${doc.brief.replace(/\.?$/, ".")}`,
      "",
      ...description(doc.description),
      ...doc.positional
        .filter((arg) => arg.brief)
        .map((arg) => `- \`<${arg.placeholder}>\`: ${arg.brief.replace(/\n/g, " ")}`),
      ...own.map(flagLine),
      ...(doc.positional.some((arg) => arg.brief) || own.length > 0 ? [""] : []),
    );
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
