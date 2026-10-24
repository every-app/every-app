/**
 * The CLI reference page of the agent docs (cli.md), generated from the
 * commands themselves: the root and group help, then every command with its
 * usage, flags and full help text, so a new command or flag reaches the
 * docs by the test that compares this to the page.
 */
import {
  generateHelpTextForAllCommands,
  type Application,
  type Command,
  type CommandContext,
  type RouteMap,
} from "@stricli/core";
import { completionApp, groupHelp, rootHelp } from "@/app";
import { plain } from "./pages";

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
  /** `everyapp <path> --help`, as stricli prints it without color. */
  help: string;
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
  const helpByRoute = new Map(
    generateHelpTextForAllCommands(
      completionApp as unknown as Application<CommandContext>,
    ).map(([route, help]) => [
      route.replace(/^everyapp ?/, ""),
      plain(help),
    ]),
  );
  const docs: CommandDoc[] = [];
  const visit = (target: Target, path: string[], hidden: boolean) => {
    if ("getAllEntries" in target) {
      for (const entry of target.getAllEntries()) {
        visit(entry.target, [...path, entry.name.original], hidden || entry.hidden);
      }
      return;
    }
    const route = path.join(" ");
    docs.push({
      path: route,
      brief: target.brief,
      hidden,
      flags: flagDocs(target),
      positional: positionalDocs(target),
      help: helpByRoute.get(route) ?? "",
    });
  };
  visit(completionApp.root as unknown as Target, [], false);
  return docs;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function flagsTable(flags: FlagDoc[]): string[] {
  if (flags.length === 0) return ["No flags of its own."];
  return [
    "| Flag | Value | Required | Default | What it does |",
    "| --- | --- | --- | --- | --- |",
    ...flags.map((flag) => {
      const value =
        flag.kind === "boolean"
          ? "switch"
          : flag.kind === "counter"
            ? "repeatable switch"
            : flag.values
              ? flag.values.map((value) => `\`${value}\``).join(", ")
              : `\`<${flag.placeholder ?? "value"}>\`${flag.variadic ? " (repeatable)" : ""}`;
      return `| \`--${flag.name}\`${flag.hidden ? " (hidden)" : ""} | ${value} | ${flag.optional ? "no" : "yes"} | ${flag.default === undefined ? "" : `\`${flag.default}\``} | ${cell(flag.brief)} |`;
    }),
  ];
}

function positionalTable(positional: PositionalDoc[]): string[] {
  if (positional.length === 0) return [];
  return [
    "| Argument | Required | What it is |",
    "| --- | --- | --- |",
    ...positional.map(
      (arg) =>
        `| \`<${arg.placeholder}>${arg.list ? "..." : ""}\` | ${arg.optional ? "no" : "yes"} | ${cell(arg.brief)} |`,
    ),
    "",
  ];
}

const GROUPS = ["gateway", "secret", "email", "db", "workflow", "completion"];

/** The whole page. */
export function cliReference(): string {
  const docs = commandDocs();
  const out: string[] = [
    "---",
    'title: "CLI reference"',
    'description: "Every everyapp command with its arguments, flags, defaults and help text, generated from the CLI itself. Exit codes and the global flags are here too."',
    "---",
    "",
    "<!-- Generated from packages/cli/src/app.ts and the command definitions by packages/cli/src/docs/cliReference.ts; the test in packages/cli/src/docs/agentDocs.test.ts fails when this page is stale. Regenerate with `pnpm -C packages/cli docs:update`. -->",
    "",
    "The command is `everyapp`, run as `pnpm everyapp` from the Every App checkout (publishing to npm is paused; never `npx everyapp`). Every command takes `--help`; an agent adds `--json` and reads the event stream described on [/docs/agent/json](/docs/agent/json). What each error code means is on [/docs/agent/errors](/docs/agent/errors).",
    "",
    "## Exit codes",
    "",
    "| Code | Meaning |",
    "| --- | --- |",
    "| `0` | Done. |",
    "| `1` | An `error` event ended the run, whatever came before it (a declined prompt, `CANCELLED`, exits 1 too). |",
    "| `2` | The run stopped on an `action_required` event: do the action, then run the command in its `data.rerun`. |",
    "| `130` | Stopped with Ctrl-C. |",
    "| `251` | No such command (`UNKNOWN_COMMAND`). |",
    "| `252` | Bad arguments: an unknown flag, a missing or invalid value (`UNKNOWN_FLAG`, `INVALID_VALUE`, `MISSING_ARGUMENT`, `MISSING_FLAG_VALUE`, `TOO_MANY_ARGUMENTS`, `REPEATED_FLAG`). |",
    "",
    "## Global flags",
    "",
    "| Flag | What it does |",
    "| --- | --- |",
    "| `--json` | Print NDJSON events on stdout and never prompt. Read before any command parses its arguments, so argument errors are events too. |",
    "| `--verbose` | Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace. |",
    "| `--no-color` | Print without colors (also `NO_COLOR=1`). |",
    "| `-h`, `--help` | Help for everyapp or a command; `-H`, `--help-all` also shows hidden commands and flags. |",
    "| `-v`, `--version` | everyapp's version. |",
    "",
    "## `everyapp --help`",
    "",
    "```text",
    plain(rootHelp(true)).trimEnd(),
    "```",
    "",
    "## Command groups",
    "",
  ];
  for (const group of GROUPS) {
    const help = groupHelp([group]);
    if (!help) continue;
    out.push(`### \`everyapp ${group}\``, "", "```text", plain(help).trimEnd(), "```", "");
  }
  out.push("## Commands", "");
  for (const doc of docs) {
    out.push(
      `### \`everyapp ${doc.path}\`${doc.hidden ? " (hidden)" : ""}`,
      "",
      `${doc.brief.replace(/\.?$/, ".")}`,
      "",
      ...positionalTable(doc.positional),
      ...flagsTable(doc.flags),
      "",
      "```text",
      doc.help.trimEnd(),
      "```",
      "",
    );
  }
  return out.join("\n");
}
