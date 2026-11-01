import { describe, expect, it } from "vitest";
import type { RunOptions } from "./docker";
import {
  commandLinesFrom,
  formatDoctor,
  missingFlags,
  parseCommandLine,
  runDoctor,
} from "./doctor";
import { createHarness, HARNESS_NAMES } from "./harnesses/index";
import type { HarnessAdapter } from "./types";

/** The adapters' own lines, as doctor checks them. */
const ADAPTER_LINES = commandLinesFrom(
  HARNESS_NAMES.map((name) => createHarness(name)),
);

describe("parseCommandLine", () => {
  it("reads a sh -c exec wrapper with a redirect: the binary, no subcommand, the flags", () => {
    const claude = ADAPTER_LINES.find((line) => line.harness === "claude")!;
    expect(parseCommandLine(claude.argv)).toEqual({
      binary: "claude",
      subcommand: null,
      flags: [
        "-p",
        "--output-format",
        "--verbose",
        "--dangerously-skip-permissions",
        "--allow-dangerously-skip-permissions",
        "--max-budget-usd",
        "--model",
      ],
    });
  });

  it("reads a subcommand, skips a lone `-` (stdin) and values, dedupes, stops at --", () => {
    const codex = ADAPTER_LINES.find((line) => line.harness === "codex")!;
    expect(parseCommandLine(codex.argv)).toEqual({
      binary: "codex",
      subcommand: "exec",
      flags: [
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-m",
        "-o",
      ],
    });
    expect(
      parseCommandLine([
        "/home/dev/.local/bin/hermes",
        "chat",
        "--format=stream-json",
        "--format",
        "x",
        "--",
        "--not-a-flag",
      ]),
    ).toEqual({
      binary: "hermes",
      subcommand: "chat",
      flags: ["--format"],
    });
  });
});

describe("missingFlags", () => {
  it("accepts a flag named in the help in the usual ways and reports the rest", () => {
    const help = [
      "Usage: codex exec [OPTIONS] [PROMPT]",
      "  -m, --model <MODEL>",
      "      --json  Print events",
      "  -o, --output-last-message <FILE>",
      "  --skip-git-repo-check",
      "  --sandbox <MODE> [possible values: read-only, workspace-write]",
    ].join("\n");
    expect(
      missingFlags(help, [
        "--json",
        "-m",
        "--skip-git-repo-check",
        "-o",
        "--sandbox",
      ]),
    ).toEqual([]);
    expect(
      missingFlags(help, [
        "--dangerously-bypass-approvals-and-sandbox",
        "--jso",
      ]),
    ).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--jso"]);
    // `--json` must not satisfy `--js`, nor `--model-x` satisfy `--model`.
    expect(missingFlags("--json\n--model-x", ["--js", "--model"])).toEqual([
      "--js",
      "--model",
    ]);
  });
});

describe("runDoctor", () => {
  const helps: Record<string, string> = {
    "opencode run --help":
      "Usage: opencode run [message..]\nOptions:\n  -m, --model  model\n  --format  json\n  --auto  auto-approve\n  --standalone  no server\n  -s, --session",
    "agent --help":
      "Usage: agent [options] [prompt]\n  -p, --print\n  --force\n  --trust\n  --sandbox <mode>\n  --output-format <f>\n  --model <m>",
  };
  const runner = {
    calls: [] as Array<{ argv: string[]; options?: RunOptions }>,
    run: async (_image: string, argv: string[], options?: RunOptions) => {
      runner.calls.push({ argv, options });
      if (argv.at(-1) === "--version")
        return { code: 0, stdout: [`${argv[0]} 1.2.3`], stderr: [] };
      const help = helps[argv.join(" ")];
      return help
        ? { code: 0, stdout: help.split("\n"), stderr: [] }
        : { code: 1, stdout: [], stderr: ["unknown command"] };
    },
  };

  it("validates each line against --help inside the image as dev and reports the missing flags", async () => {
    const lines = ADAPTER_LINES.filter((line) =>
      ["opencode", "cursor", "hermes"].includes(line.harness),
    );
    const results = await runDoctor("everyapp-loop:abc", lines, runner);
    expect(
      results.map((r) => [r.harness, r.ok, r.missing, r.helpExit, r.version]),
    ).toEqual([
      ["opencode", true, [], 0, "opencode 1.2.3"],
      ["cursor", true, [], 0, "agent 1.2.3"],
      [
        "hermes",
        false,
        ["--query-file", "--oneshot", "--format", "--yolo", "--provider", "-m"],
        1,
        "hermes 1.2.3",
      ],
    ]);
    expect(results[0]?.helpArgv).toEqual(["opencode", "run", "--help"]);
    expect(runner.calls[0]?.options).toMatchObject({
      user: "dev",
      workdir: "/work",
    });
    const text = formatDoctor(results);
    expect(text[0]).toMatch(
      /^ok {3}opencode {1}opencode \(opencode 1\.2\.3\): 4 flags found/,
    );
    expect(text[2]).toMatch(
      /^FAIL hermes {3}hermes \(hermes 1\.2\.3\): `hermes chat --help` exited 1/,
    );
  });

  it("takes the lines from the adapters when they exist, skipping the control", () => {
    const adapter = (name: HarnessAdapter["name"]): HarnessAdapter => ({
      name,
      version: "x",
      status: "measured",
      providerVar: null,
      defaultModel: "model-1",
      signal: {
        toolCalls: "full",
        toolOutput: "full",
        exitCodes: true,
        cost: "none",
        resume: "none",
      },
      permissionBypass: true,
      command: (launch) => ({
        argv: [name, "--model", launch.model ?? "", launch.promptPath],
        env: { X: "1" },
      }),
      resume: () => null,
      normalize: () => [],
      collectPaths: [],
      fixture: null,
    });
    expect(commandLinesFrom([adapter("script"), adapter("codex")])).toEqual([
      {
        harness: "codex",
        argv: ["codex", "--model", "model-1", "/loop/prompt.txt"],
        env: { X: "1" },
      },
    ]);
  });
});
