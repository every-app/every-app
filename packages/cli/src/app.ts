import chalk from "chalk";
import {
  buildApplication,
  buildRouteMap,
  text_en,
  type Application,
  type Command,
  type CommandContext,
  type RouteMap,
} from "@stricli/core";
import { name, version } from "../package.json";
import {
  argumentProblem,
  ArgumentErrorCode,
  commandPath,
  unknownCommand,
  type ArgumentProblem,
} from "./argumentErrors";
import { accessRoutes } from "./commands/access/command";
import { configureCommand } from "./commands/configure/command";
import { createCommand } from "./commands/create/command";
import { dbRoutes } from "./commands/db/command";
import { deleteCommand } from "./commands/delete/command";
import { deployCommand } from "./commands/deploy/command";
import { devCommand } from "./commands/dev/command";
import { emailRoutes } from "./commands/email/command";
import { eventsRoutes } from "./commands/events/command";
import { installCommand } from "./commands/install/command";
import { loginCommand } from "./commands/login/command";
import { mcpRoutes } from "./commands/mcp/command";
import { providerRoutes } from "./commands/provider/command";
import { releaseCommand } from "./commands/release/command";
import { secretRoutes } from "./commands/secret/command";
import { setupCommand } from "./commands/setup/command";
import { statusCommand } from "./commands/status/command";
import { teardownCommand } from "./commands/teardown/command";
import { updateCommand } from "./commands/update/command";
import { workspaceRoutes } from "./commands/workspace/command";
import { errorMessage } from "./lib/errors";
import { CLI } from "./lib/output/command";

const routes = buildRouteMap({
  routes: {
    create: createCommand,
    dev: devCommand,
    deploy: deployCommand,
    release: releaseCommand,
    db: dbRoutes,
    teardown: teardownCommand,
    login: loginCommand,
    setup: setupCommand,
    update: updateCommand,
    install: installCommand,
    configure: configureCommand,
    status: statusCommand,
    delete: deleteCommand,
    access: accessRoutes,
    secret: secretRoutes,
    provider: providerRoutes,
    mcp: mcpRoutes,
    email: emailRoutes,
    events: eventsRoutes,
    workspace: workspaceRoutes,
  },
  // `everyapp provider …` was `mcp`'s name until 2026-10-24; it is the
  // provider registry's group now, and its hidden `on|off` run `mcp on|off`
  // through launch week for documents that still say them.
  docs: {
    brief: "Deploy and run Every App apps on your own Cloudflare account.",
  },
});

/** The routes as the argument-error helpers walk them, whatever each command's flags. */
const routeMap = routes as unknown as RouteMap<CommandContext>;

/**
 * Every path the router answers to ("status", "secret set", "secret ls"),
 * groups and aliases included: what a document may tell someone to run
 * (lib/app/setupSkills.test.ts checks the setup files).
 */
export function commandPaths(): string[] {
  const paths: string[] = [];
  const walk = (target: RouteMap<CommandContext> | Command<CommandContext>, prefix: string[]) => {
    if (prefix.length > 0) paths.push(prefix.join(" "));
    if (!("getAllEntries" in target)) return;
    for (const entry of target.getAllEntries()) {
      for (const name of [entry.name.original, ...entry.aliases]) walk(entry.target, [...prefix, name]);
    }
  };
  walk(routeMap, []);
  return paths;
}

/**
 * The commands `everyapp --help` lists, by what the person is doing:
 * building an app of their own, running the Gateway and the apps on it,
 * or managing the people and apps of its workspace.
 */
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["BUILD AN APP", ["create", "dev", "deploy", "release", "db"]],
  [
    "RUN A GATEWAY",
    [
      "login",
      "setup",
      "update",
      "install",
      "configure",
      "status",
      "delete",
      "access",
      "secret",
      "provider",
      "mcp",
      "email",
      "events",
      "teardown",
    ],
  ],
  ["MANAGE THE WORKSPACE", ["workspace"]],
];

/** What `everyapp <group> --help` shows as examples. */
const GROUP_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  secret: [
    "secret set GITHUB_TOKEN",
    "secret set GITHUB_TOKEN --from-env GH_TOKEN",
    "secret set MAIN_SECRET --app analytics",
    "secret list crm",
  ],
  email: ["email show", "email set --sender '*@mail.example.com'", "email unset inbound"],
  events: [
    "events add https://hooks.example.com/everyapp --events cap.*,member.*",
    "events add --email admins --events cap.*",
    "events test sub_…",
    "events deliveries --dead",
  ],
  access: ["access on", "access on --email-domain example.com", "access off"],
  provider: ["provider list", "provider add stripe.json", "provider show stripe"],
  mcp: [
    "mcp list",
    "mcp on dataforseo",
    "mcp add https://treg.to/mcp/ --auth bearer",
    "mcp show treg",
    "mcp off treg",
  ],
  db: ["db migrate", "db query 'select count(*) from todos'"],
  workspace: [
    "workspace rename 'Acme Corp'",
    "workspace users",
    "workspace role sam@example.com owner",
    "workspace role sam@example.com member",
    "workspace invite ann@example.com --role admin",
    "workspace app access crm --add ann@example.com",
    "workspace group members Sales --set ann@example.com --set bob@example.com",
    "workspace usage --month 2026-10 --json",
  ],
};

/** What a group's help says under its brief, where one line isn't enough. */
const GROUP_NOTES: Readonly<Record<string, readonly string[]>> = {
  email: [
    "Invites, and apps that don't set their own senders, send as the Gateway's sender.",
    `Set it with: ${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`,
  ],
  events: [
    "Each webhook is signed: X-EveryApp-Signature, HMAC-SHA256 over <t>.<body>; verify it with the snippet on /docs/events.",
  ],
  workspace: [
    "Everything Admin → Users, Groups, Apps, Tokens, Usage and Activity do, from the terminal.",
    "Acts under your Cloudflare login (the operator is root in every organization of the Gateway),",
    "on the install organization unless --org names another by slug, id or name (a name two",
    "organizations share is refused: give the slug). The Gateway mails nothing from here: invite",
    "and reset-link print the link to hand over.",
    `Depth-two groups have their own help: ${CLI} workspace group --help, app, token, connection.`,
  ],
};

const briefOf = (input: string) => routes.getRoutingTargetForInput(input)!.brief;

/**
 * `everyapp`, `everyapp --help`: the commands by group, a few examples,
 * and where flags are. Every command is written as the person runs it
 * (`pnpm everyapp …` from a checkout).
 */
export function rootHelp(): string {
  const width = Math.max(...GROUPS.flatMap(([, names]) => names.map((n) => n.length)));
  const section = (title: string, names: readonly string[]) => [
    "",
    chalk.bold(title),
    ...names.map((n) => `  ${n.padEnd(width)}  ${briefOf(n)}`),
  ];
  return [
    routes.brief,
    "",
    chalk.bold("USAGE"),
    `  ${CLI} <command> [flags]`,
    ...GROUPS.flatMap(([title, names]) => section(title, names)),
    "",
    chalk.bold("FLAGS"),
    "  -h, --help      Show help for everyapp or a command",
    "  -v, --version   Show everyapp's version",
    "      --no-color  Print without colors (also NO_COLOR=1)",
    "",
    chalk.bold("EXAMPLES"),
    `  $ ${CLI} setup --domain apps.example.com`,
    `  $ ${CLI} create todo`,
    `  $ ${CLI} deploy`,
    `  $ ${CLI} install https://github.com/<owner>/<repo>`,
    `  $ ${CLI} configure crm`,
    "",
    `Run ${chalk.bold(`${CLI} <command> --help`)} for a command's flags.`,
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
  // The examples and notes are keyed by the group's own name; an alias of a
  // group gets the same help, under the name typed.
  const canonical =
    routeMap.getAllEntries().find((entry) => entry.target === target)?.name.original ?? group;
  const entries = target.getAllEntries().filter((entry) => !entry.hidden);
  const width = Math.max(...entries.map((entry) => entry.name.original.length));
  const examples = GROUP_EXAMPLES[canonical] ?? [];
  const notes = GROUP_NOTES[canonical] ?? [];
  return [
    `${target.brief}.`,
    ...(notes.length > 0 ? ["", ...notes] : []),
    "",
    chalk.bold("USAGE"),
    `  ${CLI} ${group} <command> [flags]`,
    "",
    chalk.bold("COMMANDS"),
    ...entries.map((entry) => `  ${entry.name.original.padEnd(width)}  ${entry.target.brief}`),
    ...(examples.length > 0
      ? ["", chalk.bold("EXAMPLES"), ...examples.map((example) => `  $ ${CLI} ${example}`)]
      : []),
    "",
    `Run ${chalk.bold(`${CLI} ${group} <command> --help`)} for its flags.`,
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
 * whether its help may use color. Its name is the invocation the person
 * used (`CLI`), so usage lines say what to type.
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
}): Application<CommandContext> {
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
    name: CLI,
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
  }) as unknown as Application<CommandContext>;
}
