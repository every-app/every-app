/**
 * What stricli's argument parser and router refuse, said like everyapp's
 * own errors: an `error` event (bin/cli.ts reports it through the run's
 * sink, so `--json` gets NDJSON) with a code from {@link ArgumentErrorCode},
 * a headline, and what to do next: a close match (`data.didYouMean`), the
 * command's usage (`data.usage`) or its help (`data.help`). The exit code
 * stays stricli's: 251 for a command it can't find, 252 for arguments.
 */
import {
  AliasNotFoundError,
  ArgumentParseError,
  EnumValidationError,
  FlagNotFoundError,
  InvalidNegatedFlagSyntaxError,
  UnexpectedFlagError,
  UnexpectedPositionalError,
  UnsatisfiedFlagError,
  UnsatisfiedPositionalError,
  type Command,
  type CommandContext,
  type RouteMap,
} from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { listed } from "@/lib/output/text";

export enum ArgumentErrorCode {
  UnknownCommand = "UNKNOWN_COMMAND",
  UnknownFlag = "UNKNOWN_FLAG",
  InvalidValue = "INVALID_VALUE",
  MissingArgument = "MISSING_ARGUMENT",
  MissingFlagValue = "MISSING_FLAG_VALUE",
  TooManyArguments = "TOO_MANY_ARGUMENTS",
  RepeatedFlag = "REPEATED_FLAG",
  CommandFailed = "COMMAND_FAILED",
  /** A value typed after a switch that reads it elsewhere (`events add --secret <value>`). */
  ValueOnCommandLine = "VALUE_ON_COMMAND_LINE",
}

export interface ArgumentProblem {
  code: ArgumentErrorCode;
  message: string;
  data: { didYouMean?: string; usage?: string; help?: string; fix?: string };
}

type Routes = RouteMap<CommandContext>;
type RoutingTarget<CONTEXT extends CommandContext> = Command<CONTEXT> | RouteMap<CONTEXT>;

/** Said when an argument may have carried a value: it is in the shell's history already. */
const VALUE_NOTE = "\nA value never goes on the command line: it lands in the shell's history and the process list. Rotate it if it was real.";

/**
 * Switches that stand for a value read elsewhere (a hidden prompt, stdin,
 * an environment variable), as `events add --secret` does: whatever is
 * typed with one, or right after it, is that value. It is refused as
 * VALUE_ON_COMMAND_LINE and never shown back.
 */
const VALUE_SWITCHES = new Set(["secret"]);

/** The value switch typed with a value after it (`--secret abc`), if one was. */
function valueSwitchWithValue(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    const name = arg.startsWith("--") ? arg.slice(2) : "";
    const next = args[index + 1];
    if (VALUE_SWITCHES.has(name) && next !== undefined && !next.startsWith("-")) return name;
  }
  return undefined;
}

/** The refusal of a value typed for a value switch. */
function valueOnCommandLine(flag: string): ArgumentProblem {
  return {
    code: ArgumentErrorCode.ValueOnCommandLine,
    message: `--${flag} takes no value on the command line${VALUE_NOTE}`,
    data: {
      fix: `give --${flag} alone: it asks at a hidden prompt, or reads the value piped in or from --${flag}-from-env <VAR>`,
    },
  };
}

/** An argument as a message shows it: `NAME=value` cut at its `=`, since the value may be a secret. */
function shownInput(input: string): string {
  return input.includes("=") ? `${input.split("=")[0]}=…` : input;
}

/** The note, for an argument that looked like `NAME=value`. */
function valueNote(input: string): string {
  return input.includes("=") ? VALUE_NOTE : "";
}

/** The command path the arguments name ("create", "secret set") and its target, as far as it goes. */
export function commandPath(
  routes: Routes,
  args: readonly string[],
  /** A group that runs a command of its own (`dev`) as that command, as stricli does. */
  { defaults = true }: { defaults?: boolean } = {},
): { path: string[]; target: RoutingTarget<CommandContext> } {
  const path: string[] = [];
  let target: RoutingTarget<CommandContext> = routes;
  for (const arg of args) {
    if (arg.startsWith("-") || !("getRoutingTargetForInput" in target)) break;
    const next = target.getRoutingTargetForInput(arg);
    if (!next) break;
    path.push(arg);
    target = next;
  }
  if (defaults && "getDefaultCommand" in target) target = target.getDefaultCommand() ?? target;
  return { path, target };
}

/** The flag's name as typed (`--account-id` for `accountId`). */
const kebab = (flag: string) => flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * `everyapp create [<id>] [flags]`, `everyapp teardown --account-id <id>
 * [flags]`: the positional arguments in place, the required flags named,
 * the rest summed up.
 */
function usageOf(path: readonly string[], command: Command<CommandContext>): string {
  const positional = command.parameters.positional;
  const args =
    positional?.kind === "array"
      ? [`<${positional.parameter.placeholder ?? "arg"}>...`]
      : (positional?.parameters ?? []).map((parameter, index) => {
          const name = `<${parameter.placeholder ?? `arg${index + 1}`}>`;
          return parameter.optional ? `[${name}]` : name;
        });
  const required = Object.entries(command.parameters.flags ?? {}).flatMap(([key, flag]) =>
    flag.kind === "parsed" && !flag.optional && flag.default === undefined
      ? [`--${kebab(key)} <${flag.placeholder ?? "value"}>`]
      : [],
  );
  return [CLI, ...path, ...args, ...required, "[flags]"].join(" ");
}

/** Within two edits of `input`: a typo worth suggesting, not an unrelated word. */
function closeTo(input: string, candidates: readonly string[]): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** A command or group the router has no route for. */
export function unknownCommand(
  routes: Routes,
  args: readonly string[],
  input: string,
): ArgumentProblem {
  const { path, target } = commandPath(routes, args, { defaults: false });
  const names =
    "getAllEntries" in target
      ? target
          .getAllEntries()
          .filter((entry) => !entry.hidden)
          .map((entry) => entry.name.original)
      : [];
  const match = closeTo(input, names);
  return {
    code: ArgumentErrorCode.UnknownCommand,
    message: [
      `Unknown command ${[...path, input].join(" ")}`,
      ...(path.length > 0 && names.length > 0 ? [`${path.join(" ")} has ${listed(names)}.`] : []),
    ].join("\n"),
    data: {
      ...(match ? { didYouMean: [CLI, ...path, match].join(" ") } : {}),
      help: [CLI, ...path, "--help"].join(" "),
    },
  };
}

/** A problem stricli's parser found in a command's arguments. */
export function argumentProblem(
  routes: Routes,
  args: readonly string[],
  exc: unknown,
): ArgumentProblem {
  const { path, target } = commandPath(routes, args);
  const command = "parameters" in target ? target : undefined;
  const name = path.join(" ");
  const help = { help: [CLI, ...path, "--help"].join(" ") };
  const usage = command ? { usage: usageOf(path, command) } : {};
  const flags = command?.parameters.flags ?? {};

  if (exc instanceof FlagNotFoundError || exc instanceof AliasNotFoundError) {
    const shown = `${exc instanceof AliasNotFoundError ? "-" : "--"}${exc.input}`;
    const match =
      exc instanceof FlagNotFoundError ? closeTo(exc.input, Object.keys(flags).map(kebab)) : undefined;
    return {
      code: ArgumentErrorCode.UnknownFlag,
      message: `Unknown flag ${shown}${name ? ` for ${name}` : ""}`,
      data: { ...(match ? { didYouMean: `--${match}` } : {}), ...help },
    };
  }
  if (exc instanceof EnumValidationError) {
    const match = closeTo(exc.input, exc.values);
    return {
      code: ArgumentErrorCode.InvalidValue,
      message: `--${exc.externalFlagName} can't be "${exc.input}"\nUse one of: ${exc.values.join(", ")}.`,
      data: match ? { didYouMean: match } : {},
    };
  }
  if (exc instanceof ArgumentParseError) {
    const reason = exc.exception instanceof Error ? exc.exception.message : String(exc.exception);
    const flag = exc.externalFlagNameOrPlaceholder;
    const isFlag = Object.keys(flags).map(kebab).includes(flag);
    if (isFlag && VALUE_SWITCHES.has(flag)) return valueOnCommandLine(flag);
    if (isFlag && flags[Object.keys(flags).find((key) => kebab(key) === flag)!]?.kind === "boolean") {
      // What was typed after `=` is never shown: a switch takes no value,
      // so whatever it got may be one (`--from-env=<key>`).
      return {
        code: ArgumentErrorCode.InvalidValue,
        message: `--${flag} is a switch and takes no value${VALUE_NOTE}`,
        data: { fix: `use --${flag} or --no-${flag}` },
      };
    }
    if (isFlag) {
      return {
        code: ArgumentErrorCode.InvalidValue,
        message: reason.startsWith(`--${flag}`)
          ? `${reason}, not ${exc.input}`
          : `--${flag} can't be "${exc.input}"\n${reason}`,
        data: {},
      };
    }
    return {
      code: ArgumentErrorCode.InvalidValue,
      message: `"${shownInput(exc.input)}" won't do for <${flag}>\n${reason}${valueNote(exc.input)}`,
      data: usage,
    };
  }
  if (exc instanceof UnsatisfiedPositionalError) {
    const positional = command?.parameters.positional;
    // A list of them ("secret set <name>..."): its brief says what to name.
    if (positional?.kind === "array") {
      const brief = positional.parameter.brief;
      return {
        code: ArgumentErrorCode.MissingArgument,
        message: `Name at least one ${/^[A-Z]{2}/.test(brief) ? brief : `${brief.charAt(0).toLowerCase()}${brief.slice(1)}`}`,
        data: usage,
      };
    }
    const parameter =
      command?.parameters.positional?.kind === "tuple"
        ? command.parameters.positional.parameters.find((p) => p.placeholder === exc.placeholder)
        : undefined;
    // A short brief names it better than the placeholder ("the SQL to run").
    const brief = parameter && parameter.brief.length <= 30 ? parameter.brief.replace(/^the /i, "") : undefined;
    const what = brief
      ? /^[A-Z]{2}/.test(brief)
        ? brief
        : `${brief.charAt(0).toLowerCase()}${brief.slice(1)}`
      : exc.placeholder.replaceAll("-", " ");
    return { code: ArgumentErrorCode.MissingArgument, message: `Missing the ${what}`, data: usage };
  }
  if (exc instanceof UnsatisfiedFlagError) {
    // stricli throws this both for a required flag never given and for a
    // flag typed without a value; what was typed tells them apart.
    const flag = exc.externalFlagName;
    const typed = args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
    const key = Object.keys(flags).find((candidate) => kebab(candidate) === flag);
    const declared = key ? flags[key] : undefined;
    const placeholder = (declared?.kind === "parsed" && declared.placeholder) || "value";
    return {
      code: ArgumentErrorCode.MissingFlagValue,
      message: typed ? `--${flag} needs a value` : `${name || "everyapp"} needs --${flag} <${placeholder}>`,
      data: { ...usage, ...help },
    };
  }
  if (exc instanceof UnexpectedPositionalError) {
    // `--secret abc`: the extra argument is the value, wherever it landed.
    const valueSwitch = valueSwitchWithValue(args);
    if (valueSwitch) return valueOnCommandLine(valueSwitch);
    const takes = exc.expectedCount === 1 ? "one argument" : `${exc.expectedCount} arguments`;
    return {
      code: ArgumentErrorCode.TooManyArguments,
      message:
        exc.expectedCount === 0
          ? `${name || "everyapp"} takes no arguments (got "${shownInput(exc.input)}")${valueNote(exc.input)}`
          : `${name || "everyapp"} takes ${takes}, but got another: "${shownInput(exc.input)}"${valueNote(exc.input)}`,
      data: usage,
    };
  }
  if (exc instanceof InvalidNegatedFlagSyntaxError) {
    return {
      code: ArgumentErrorCode.InvalidValue,
      message: `--no-${exc.externalFlagName} is a switch and takes no value${VALUE_NOTE}`,
      data: {},
    };
  }
  if (exc instanceof UnexpectedFlagError) {
    return {
      code: ArgumentErrorCode.RepeatedFlag,
      message: `--${exc.externalFlagName} is given more than once`,
      data: help,
    };
  }
  return {
    code: ArgumentErrorCode.CommandFailed,
    message: exc instanceof Error ? exc.message : String(exc),
    data: help,
  };
}
