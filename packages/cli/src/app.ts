import chalk from "chalk";
import {
  buildApplication,
  buildRouteMap,
  text_en,
  type Application,
  type CommandContext,
  type RouteMap,
} from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { name, version } from "../package.json";
import {
  argumentProblem,
  ArgumentErrorCode,
  commandPath,
  unknownCommand,
  type ArgumentProblem,
} from "./argumentErrors";
import { createCommand } from "./commands/create/command";
import { dbRoutes } from "./commands/db/command";
import { deleteCommand } from "./commands/delete/command";
import { deployCommand } from "./commands/deploy/command";
import { devCommand } from "./commands/dev/command";
import { emailRoutes } from "./commands/email/command";
import { loginCommand } from "./commands/login/command";
import { registerCommand } from "./commands/register/command";
import { secretRoutes } from "./commands/secret/command";
import { setupCommand } from "./commands/setup/command";
import { statusCommand } from "./commands/status/command";
import { workflowsRoutes } from "./commands/workflows/command";
import type { LocalContext } from "./context";
import { errorMessage } from "./lib/errors";

const completionRoutes = buildRouteMap({
  routes: {
    install: buildInstallCommand("everyapp", { bash: "__everyapp_bash_complete" }),
    uninstall: buildUninstallCommand("everyapp", { bash: true }),
  },
  docs: { brief: "Install or remove bash completion" },
});

const routes = buildRouteMap({
  routes: {
    login: loginCommand,
    setup: setupCommand,
    status: statusCommand,
    create: createCommand,
    dev: devCommand,
    deploy: deployCommand,
    register: registerCommand,
    delete: deleteCommand,
    secret: secretRoutes,
    email: emailRoutes,
    db: dbRoutes,
    workflows: workflowsRoutes,
    completion: completionRoutes,
  },
  docs: {
    brief: "Deploy and run Every App apps on your own Cloudflare account.",
    hideRoute: { completion: true },
  },
});

/** The routes as the argument-error helpers walk them, whatever each command's flags. */
const routeMap = routes as unknown as RouteMap<CommandContext>;

/** The commands `everyapp --help` lists, in groups. */
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["GET STARTED", ["login", "setup", "create"]],
  ["APPS", ["dev", "deploy", "delete", "register"]],
  ["CONFIGURE", ["secret", "email"]],
  ["INSPECT", ["status", "db", "workflows"]],
];

/** What `everyapp <group> --help` shows as examples. */
const GROUP_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  secret: ["secret set GITHUB_TOKEN", "secret set GITHUB_TOKEN --from-env GH_TOKEN"],
  email: ["email show", "email set --inbound support@apps.example.com"],
  db: ["db migrate", "db query 'select count(*) from todos'"],
  workflows: ["workflows list", "workflows instances RANK_CHECK --status running"],
  completion: ["completion install"],
};

const briefOf = (input: string) => routes.getRoutingTargetForInput(input)!.brief;

/**
 * `everyapp`, `everyapp --help`: the commands by group, a few examples,
 * and where flags are. `all` (`--help-all`) adds the hidden ones.
 */
export function rootHelp(all: boolean): string {
  const width = Math.max(
    ...GROUPS.flatMap(([, names]) => names.map((n) => n.length)),
    ...(all ? ["completion".length] : []),
  );
  const section = (title: string, names: readonly string[]) => [
    "",
    chalk.bold(title),
    ...names.map((n) => `  ${n.padEnd(width)}  ${briefOf(n)}`),
  ];
  return [
    routes.brief,
    "",
    chalk.bold("USAGE"),
    "  everyapp <command> [flags]",
    ...GROUPS.flatMap(([title, names]) => section(title, names)),
    ...(all ? section("SHELL COMPLETION", ["completion"]) : []),
    "",
    chalk.bold("FLAGS"),
    "  -h, --help      Show help for everyapp or a command",
    ...(all ? ["  -H, --help-all  Also show hidden commands and flags"] : []),
    "  -v, --version   Show everyapp's version",
    "      --no-color  Print without colors (also NO_COLOR=1)",
    "",
    chalk.bold("EXAMPLES"),
    "  $ everyapp setup --domain apps.example.com",
    "  $ everyapp create todo",
    "  $ everyapp deploy",
    "",
    `Run ${chalk.bold("everyapp <command> --help")} for a command's flags.`,
    "",
  ].join("\n");
}

/**
 * `everyapp secret`, `everyapp secret --help`: what the group is for, its
 * commands, examples, and where their flags are; null when `args` don't
 * name just a group.
 */
export function groupHelp(args: readonly string[]): string | null {
  const rest = args.filter((arg) => arg !== "--help" && arg !== "-h");
  if (rest.length !== 1 || args.length - rest.length > 1) return null;
  const { path, target } = commandPath(routeMap, rest);
  if (path.length !== 1 || !("getAllEntries" in target)) return null;
  const group = path[0]!;
  const entries = target.getAllEntries().filter((entry) => !entry.hidden);
  const width = Math.max(...entries.map((entry) => entry.name.original.length));
  const examples = GROUP_EXAMPLES[group] ?? [];
  return [
    `${target.brief}.`,
    "",
    chalk.bold("USAGE"),
    `  everyapp ${group} <command> [flags]`,
    "",
    chalk.bold("COMMANDS"),
    ...entries.map((entry) => `  ${entry.name.original.padEnd(width)}  ${entry.target.brief}`),
    ...(examples.length > 0
      ? ["", chalk.bold("EXAMPLES"), ...examples.map((example) => `  $ everyapp ${example}`)]
      : []),
    "",
    `Run ${chalk.bold(`everyapp ${group} <command> --help`)} for its flags.`,
    "",
  ].join("\n");
}

/** `everyapp --version`. */
export function versionLine(): string {
  return `${name} ${version}\n`;
}

/**
 * The application, with every problem stricli finds in the arguments (an
 * unknown command or flag, a bad value) handed to `report` as an
 * {@link ArgumentProblem} instead of written by stricli; `color` says
 * whether its help may use color.
 */
export function buildApp({
  color,
  args,
  report,
}: {
  color: boolean;
  /** The arguments it runs with, for what the problems name. */
  args: readonly string[];
  report: (problem: ArgumentProblem) => void;
}): Application<LocalContext> {
  const reported = (problem: ArgumentProblem) => {
    report(problem);
    // stricli writes what this returns; the report said it already.
    return "";
  };
  const failed = (exc: unknown) =>
    reported({
      code: ArgumentErrorCode.CommandFailed,
      message: errorMessage(exc),
      data: {},
    });
  return buildApplication(routes, {
    name,
    versionInfo: { currentVersion: version },
    scanner: {
      allowArgumentEscapeSequence: true,
      caseStyle: "allow-kebab-for-camel",
    },
    documentation: {
      caseStyle: "convert-camel-to-kebab",
      disableAnsiColor: !color,
    },
    localization: {
      loadText: () => ({
        ...text_en,
        exceptionWhileParsingArguments: (exc) => reported(argumentProblem(routeMap, args, exc)),
        noCommandRegisteredForInput: ({ input }) => reported(unknownCommand(routeMap, args, input)),
        exceptionWhileLoadingCommandFunction: failed,
        exceptionWhileRunningCommand: failed,
        commandErrorResult: failed,
      }),
    },
  });
}

/** For shell completion, which reports nothing. */
export const completionApp = buildApp({ color: false, args: [], report: () => undefined });

