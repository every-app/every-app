import { ExitCode, run } from "@stricli/core";
import { describe, expect, it } from "vitest";
import { buildApp, groupHelp, rootHelp, versionLine } from "./app";
import type { ArgumentProblem } from "./argumentErrors";
import { buildContext } from "./context";

/** Run everyapp's parser on `args`: what it reports, and stricli's exit code. */
async function parse(...args: string[]) {
  const problems: ArgumentProblem[] = [];
  const app = buildApp({ color: false, args, report: (problem) => problems.push(problem) });
  const stricliProcess = { stdout: { write: () => true }, stderr: { write: () => true }, env: {}, exitCode: undefined as number | undefined };
  await run(app, args, { ...buildContext(process), process: stricliProcess as unknown as NodeJS.Process });
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
    expect((await parse("create", "--deploy=maybe")).problems[0]).toEqual({
      code: "INVALID_VALUE",
      message: '--deploy is a switch and takes no value (got "maybe")',
      data: { fix: "use --deploy or --no-deploy" },
    });
    expect((await parse("workflows", "instances", "RANK", "--limit", "500")).problems[0]!.message).toBe(
      "--limit must be a whole number from 1 to 100, not 500",
    );
    // Kebab-case values, and no far-fetched suggestion.
    expect((await parse("workflows", "instances", "RANK", "--status", "nope")).problems[0]).toEqual({
      code: "INVALID_VALUE",
      message:
        '--status can\'t be "nope"\nUse one of: queued, running, paused, waiting, waiting-for-pause, errored, terminated, complete, rolling-back.',
      data: {},
    });
    expect((await parse("workflows", "instances", "RANK", "--status", "runing")).problems[0]!.data).toEqual({
      didYouMean: "running",
    });
  });

  it("shows where a missing or extra argument goes", async () => {
    expect((await parse("workflows", "get", "RANK")).problems[0]!.message).toBe("Missing the instance id");
    expect((await parse("create", "a", "b")).problems[0]).toEqual({
      code: "TOO_MANY_ARGUMENTS",
      message: 'create takes one argument, but got another: "b"',
      data: { usage: "pnpm everyapp create [<id>] [flags]" },
    });
    expect((await parse("secret", "set", "--from-env")).problems[0]).toMatchObject({
      code: "MISSING_FLAG_VALUE",
      message: "--from-env needs a value",
    });
  });
});

describe("help", () => {
  it("lists the commands by group, and completion only with --help-all", () => {
    expect(rootHelp(false)).toContain("GET STARTED");
    expect(rootHelp(false)).not.toContain("completion");
    expect(rootHelp(true)).toContain("SHELL COMPLETION\n  completion  Install or remove bash completion");
  });

  it("shows a group's commands and examples for the group alone, or with --help", () => {
    for (const args of [["secret"], ["secret", "--help"], ["email"]]) {
      expect(groupHelp(args)).toMatch(/^.+\.\n\nUSAGE\n  everyapp \w+ <command> \[flags\]\n\nCOMMANDS\n/);
    }
    expect(groupHelp(["secret", "set"])).toBeNull();
    expect(groupHelp(["create"])).toBeNull();
  });

  it("names the tool with its version", () => {
    expect(versionLine()).toMatch(/^everyapp \d+\.\d+\.\d+\n$/);
  });
});
