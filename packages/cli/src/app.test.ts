import { ExitCode, run } from "@stricli/core";
import { describe, expect, it } from "vitest";
import { buildApp, commandPaths, groupHelp, rootHelp, versionLine } from "./app";
import type { ArgumentProblem } from "./argumentErrors";
import { buildContext } from "./context";
import { CLI } from "./lib/output/command";

/** Run everyapp's parser on `args`: what it reports, and stricli's exit code. */
async function parse(...args: string[]) {
  const problems: ArgumentProblem[] = [];
  const app = buildApp({ color: false, args, report: (problem) => problems.push(problem) });
  const stricliProcess = { stdout: { write: () => true }, stderr: { write: () => true }, env: {}, exitCode: undefined as number | undefined };
  await run(app, args, buildContext(stricliProcess as unknown as NodeJS.Process));
  return { problems, exitCode: stricliProcess.exitCode };
}

describe("argument problems", () => {
  it("names an unknown command, a close match, and where the commands are", async () => {
    await expect(parse("frobnicate")).resolves.toEqual({
      problems: [{ code: "UNKNOWN_COMMAND", message: "Unknown command frobnicate", data: { help: "pnpm everyapp --help" } }],
      // 251 once the process exits.
      exitCode: ExitCode.UnknownCommand,
    });
    expect((await parse("creat")).problems[0]!.data).toEqual({
      didYouMean: "pnpm everyapp create",
      help: "pnpm everyapp --help",
    });
    expect((await parse("secret", "frob")).problems[0]).toEqual({
      code: "UNKNOWN_COMMAND",
      message: "Unknown command secret frob\nsecret has set, unset and list.",
      data: { help: "pnpm everyapp secret --help" },
    });
  });

  it("names an unknown flag for its command, with a suggestion only when it is close", async () => {
    expect(await parse("create", "--bogus")).toEqual({
      problems: [
        { code: "UNKNOWN_FLAG", message: "Unknown flag --bogus for create", data: { help: "pnpm everyapp create --help" } },
      ],
      // 252 once the process exits.
      exitCode: ExitCode.InvalidArgument,
    });
    expect((await parse("create", "--jsn")).problems[0]!.data).toMatchObject({ didYouMean: "--json" });
    expect((await parse("create", "-x")).problems[0]!.message).toBe("Unknown flag -x for create");
  });

  it("says what is wrong with a value, in the words a person typed", async () => {
    expect((await parse("create", "--yes=maybe")).problems[0]).toEqual({
      code: "INVALID_VALUE",
      message:
        "--yes is a switch and takes no value\nA value never goes on the command line: it lands in the shell's history and the process list. Rotate it if it was real.",
      data: { fix: "use --yes or --no-yes" },
    });
    expect((await parse("dev", "--port", "many")).problems[0]).toMatchObject({
      code: "INVALID_VALUE",
      message: expect.stringMatching(/^--port can't be "many"\n/),
    });
  });

  it("shows where a missing or extra argument goes", async () => {
    expect((await parse("install")).problems[0]).toEqual({
      code: "MISSING_ARGUMENT",
      message: "Missing the source",
      data: { usage: "pnpm everyapp install <source> [flags]" },
    });
    expect((await parse("create", "a", "b")).problems[0]).toEqual({
      code: "TOO_MANY_ARGUMENTS",
      message: 'create takes one argument, but got another: "b"',
      data: { usage: "pnpm everyapp create [<name>] [flags]" },
    });
    expect((await parse("deploy", "https://github.com/acme/todo")).problems[0]).toEqual({
      code: "TOO_MANY_ARGUMENTS",
      message: 'deploy takes no arguments (got "https://github.com/acme/todo")',
      data: { usage: "pnpm everyapp deploy [flags]" },
    });
    expect((await parse("secret", "set", "GITHUB_TOKEN", "--from-env")).problems[0]).toMatchObject({
      code: "MISSING_FLAG_VALUE",
      message: "--from-env needs a value",
    });
  });


  it("never echoes an argument that may be a value: NAME=value is cut at its =, a switch's value isn't shown", async () => {
    const extra = (await parse("configure", "crm", "OPENAI_API_KEY=sk-live-abc123")).problems[0];
    expect(extra).toMatchObject({ code: "TOO_MANY_ARGUMENTS" });
    expect(extra!.message).toBe(
      'configure takes one argument, but got another: "OPENAI_API_KEY=…"\nA value never goes on the command line: it lands in the shell\'s history and the process list. Rotate it if it was real.',
    );
    expect(extra!.message).not.toContain("sk-live");
    const switched = (await parse("configure", "crm", "--from-env=sk-live-abc123")).problems[0];
    expect(switched).toMatchObject({ code: "INVALID_VALUE", data: { fix: "use --from-env or --no-from-env" } });
    expect(switched!.message).toBe(
      "--from-env is a switch and takes no value\nA value never goes on the command line: it lands in the shell's history and the process list. Rotate it if it was real.",
    );
    expect(switched!.message).not.toContain("sk-live");
  });
  it("tells a required flag never given from a flag typed without a value, and names it in the usage", async () => {
    expect((await parse("teardown", "--dry-run")).problems[0]).toEqual({
      code: "MISSING_FLAG_VALUE",
      message: "teardown needs --account-id <id>",
      data: { usage: "pnpm everyapp teardown --account-id <id> [flags]", help: "pnpm everyapp teardown --help" },
    });
    expect((await parse("teardown", "--account-id")).problems[0]).toMatchObject({
      code: "MISSING_FLAG_VALUE",
      message: "--account-id needs a value",
    });
  });

  it("lets install take over what deploy can, so a takeover's rerun parses", async () => {
    const takeovers = ["--force-dns", "--allow-delete-durable-object-data", "--allow-delete-workflows", "--enable-email-routing"];
    for (const command of ["deploy", "install"]) {
      const args = command === "install" ? ["https://github.com/acme/todo"] : [];
      // The command is loaded (and would run) once the arguments parse; a
      // bad flag is reported before the loader runs. `--no-wait --yes` alone
      // exercise the loader's import without the argument check failing.
      const { problems } = await parse(command, ...args, ...takeovers, "--bogus");
      expect(problems).toEqual([
        { code: "UNKNOWN_FLAG", message: `Unknown flag --bogus for ${command}`, data: { help: `pnpm everyapp ${command} --help` } },
      ]);
    }
  });

  it("asks for at least one of a list of arguments, each checked", async () => {
    expect((await parse("secret", "set")).problems[0]).toEqual({
      code: "MISSING_ARGUMENT",
      message: "Name at least one secret or Gateway setting",
      data: { usage: "pnpm everyapp secret set <name>... [flags]" },
    });
    expect((await parse("email", "unset")).problems[0]).toEqual({
      code: "MISSING_ARGUMENT",
      message: "Name at least one list to clear: senders or inbound",
      data: { usage: "pnpm everyapp email unset <senders|inbound>... [flags]" },
    });
    expect((await parse("email", "unset", "--inbound")).problems[0]!.code).toBe("UNKNOWN_FLAG");
    expect((await parse("email", "unset", "everything")).problems[0]).toMatchObject({
      code: "INVALID_VALUE",
      message: '"everything" won\'t do for <senders|inbound>\nUse senders, inbound, or both.',
    });
  });
});

describe("the command tree", () => {
  it("has the build verbs, the run verbs, and nothing hidden", () => {
    const paths = commandPaths();
    for (const route of ["create", "dev", "deploy", "release", "db migrate", "login", "setup", "update", "install", "configure", "status", "delete", "access on", "secret set", "email show"]) {
      expect(paths).toContain(route);
    }
    for (const gone of ["gateway", "gateway deploy", "workflow", "completion"]) {
      expect(paths).not.toContain(gone);
    }
  });
});

describe("help", () => {
  it("lists the commands by what the person is doing, as they run everyapp", () => {
    const help = rootHelp();
    expect(help).toMatch(/\nBUILD AN APP\n  create {2,}Create .*\n  dev /);
    expect(help).toMatch(/\nRUN A GATEWAY\n  login {2,}Log in .*\n  setup {2,}Install or repair the Gateway\n  update {2,}Update the Gateway to this checkout \(after git pull\)\n  install /);
    expect(help).toContain(`USAGE\n  ${CLI} <command> [flags]`);
    expect(help).toContain(`  $ ${CLI} install https://github.com/<owner>/<repo>`);
    expect(help).not.toContain("completion");
    expect(help).not.toContain("--help-all");
  });

  it("shows a group's commands and examples for the group alone, or with --help", () => {
    for (const args of [["secret"], ["secret", "--help"], ["db"], ["access"]]) {
      expect(groupHelp(args)).toMatch(
        new RegExp(`^.+\\.\\n\\nUSAGE\\n  ${CLI} \\w+ <command> \\[flags\\]\\n\\nCOMMANDS\\n`),
      );
    }
    expect(groupHelp(["secret"])).toContain(`  $ ${CLI} secret set GITHUB_TOKEN`);
    // An alias of a group gets the group's examples, under the name typed.
    expect(groupHelp(["provider"])).toContain(`  $ ${CLI} mcp on dataforseo`);
    expect(groupHelp(["provider"])).toContain(`${CLI} provider <command> [flags]`);
    expect(groupHelp(["secret", "set"])).toBeNull();
    expect(groupHelp(["create"])).toBeNull();
  });

  it("says under email what the Gateway's own sender is, and the command that sets it", () => {
    for (const args of [["email"], ["email", "--help"]]) {
      expect(groupHelp(args)).toContain(
        `.\n\nInvites, and apps that don't set their own senders, send as the Gateway's sender.\nSet it with: ${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME\n\nUSAGE\n  ${CLI} email <command> [flags]\n\nCOMMANDS\n`,
      );
    }
  });

  it("names the tool with its version", () => {
    expect(versionLine()).toMatch(/^everyapp \d+\.\d+\.\d+\n$/);
  });
});
