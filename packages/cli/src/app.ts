import chalk, { Chalk } from "chalk";
import {
  AliasNotFoundError,
  ArgumentScannerError,
  buildApplication,
  buildRouteMap,
  FlagNotFoundError,
  formatMessageForArgumentScannerError,
  text_en,
} from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { name, version, description } from "../package.json";
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
import { CLI } from "./lib/output/command";

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
    install: buildInstallCommand("everyapp", {
      bash: "__everyapp_bash_complete",
    }),
    uninstall: buildUninstallCommand("everyapp", { bash: true }),
  },
  docs: {
    brief: description,
    hideRoute: {
      install: true,
      uninstall: true,
    },
  },
});

/** The commands `everyapp --help` lists, in groups. */
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["GET STARTED", ["login", "setup", "create"]],
  ["APPS", ["dev", "deploy", "delete", "register"]],
  ["CONFIGURE", ["secret", "email"]],
  ["INSPECT", ["status", "db", "workflows"]],
];

/** `everyapp`, `everyapp --help`: the commands by group, a few examples, and where flags are. */
export function rootHelp(): string {
  const width = Math.max(...GROUPS.flatMap(([, names]) => names.map((n) => n.length)));
  return [
    "Deploy and run Every App apps on your own Cloudflare account.",
    "",
    chalk.bold("USAGE"),
    "  everyapp <command> [flags]",
    ...GROUPS.flatMap(([title, names]) => [
      "",
      chalk.bold(title),
      ...names.map(
        (n) => `  ${n.padEnd(width)}  ${routes.getRoutingTargetForInput(n)!.brief}`,
      ),
    ]),
    "",
    chalk.bold("FLAGS"),
    "  -h, --help     Show help for everyapp or a command",
    "  -v, --version  Show everyapp's version",
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

/** The command the arguments name ("create", "secret set"), for its --help. */
function commandOf(args: readonly string[]): string {
  const [first, second] = args;
  const target = first ? routes.getRoutingTargetForInput(first) : undefined;
  if (!first || !target) return "";
  const nested =
    "getRoutingTargetForInput" in target && second && !second.startsWith("-")
      ? target.getRoutingTargetForInput(second)
      : undefined;
  return nested ? `${first} ${second}` : first;
}

/** A problem with the arguments, said like everyapp's own errors. */
function parseError(exc: unknown, ansiColor: boolean): string {
  const color = ansiColor ? chalk : new Chalk({ level: 0 });
  const command = commandOf(process.argv.slice(2));
  const lines =
    exc instanceof FlagNotFoundError || exc instanceof AliasNotFoundError
      ? [
          `Unknown flag ${exc instanceof AliasNotFoundError ? "-" : "--"}${exc.input}${command ? ` for ${command}` : ""}`,
          ...(exc instanceof FlagNotFoundError && exc.corrections.length > 0
            ? [`  Did you mean ${exc.corrections.map((c) => color.bold(`--${c}`)).join(" or ")}?`]
            : []),
        ]
      : [
          exc instanceof ArgumentScannerError
            ? formatMessageForArgumentScannerError(exc, {})
            : String(exc),
        ];
  return [
    `${color.red("✗")} ${lines[0]}`,
    ...lines.slice(1),
    `  Run: ${color.bold(`${CLI}${command ? ` ${command}` : ""} --help`)}`,
  ].join("\n");
}

export const app = buildApplication(routes, {
  name,
  versionInfo: {
    currentVersion: version,
  },
  scanner: {
    allowArgumentEscapeSequence: true,
    caseStyle: "allow-kebab-for-camel",
  },
  documentation: {
    caseStyle: "convert-camel-to-kebab",
  },
  localization: {
    loadText: () => ({
      ...text_en,
      exceptionWhileParsingArguments: parseError,
      noCommandRegisteredForInput: ({ input, corrections, ansiColor }) => {
        const color = ansiColor ? chalk : new Chalk({ level: 0 });
        // A group's ("secret sett"), or a top-level one.
        const group = commandOf(process.argv.slice(2));
        return [
          `${color.red("✗")} Unknown command ${input}${group ? ` for ${group}` : ""}`,
          ...(corrections.length > 0
            ? [`  Did you mean ${corrections.map((c) => color.bold(c.replaceAll("`", ""))).join(" or ")}?`]
            : []),
          `  Run: ${color.bold(`${CLI}${group ? ` ${group}` : ""} --help`)}`,
        ].join("\n");
      },
    }),
  },
});
