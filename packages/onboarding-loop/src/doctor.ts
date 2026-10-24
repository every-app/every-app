/**
 * `pnpm loop doctor` (design 4.4, must-fix 3): builds the image when it is
 * missing, then runs each harness's command line against `--help` inside
 * it (`docker run --rm <image> <bin> [sub] --help` as dev) and lists every
 * flag the command line uses that the help does not name, plus each
 * binary's `--version`. The command lines are the adapters' own turn-1
 * lines (src/harnesses), so what doctor checks is what a run executes.
 */
import path from "node:path";
import {
  createDocker,
  imageTag,
  resolveDockerBinary,
  type Docker,
  type RunOutput,
} from "./docker";
import { createHarness, HARNESS_NAMES } from "./harnesses/index";
import type { HarnessAdapter, HarnessName } from "./types";

interface DoctorCommandLine {
  harness: HarnessName;
  argv: string[];
  /** Non-secret variables the harness is run with (DISABLE_AUTOUPDATER=1, …). */
  env?: Record<string, string>;
}

/** The adapters' turn-1 lines, the control (bash) skipped. */
export function commandLinesFrom(
  adapters: HarnessAdapter[],
): DoctorCommandLine[] {
  return adapters
    .filter((adapter) => adapter.name !== "script")
    .map((adapter) => {
      const command = adapter.command({
        promptPath: "/loop/prompt.txt",
        model: adapter.defaultModel ?? undefined,
      });
      return { harness: adapter.name, argv: command.argv, env: command.env };
    });
}

interface ParsedCommandLine {
  binary: string;
  /** The first word after the binary when it is a subcommand (exec, run, chat). */
  subcommand: string | null;
  flags: string[];
}

/** The binary, its subcommand and its flags, through a `sh -c "exec <line> < file"` wrapper when there is one. */
export function parseCommandLine(argv: string[]): ParsedCommandLine {
  let words = argv;
  if ((argv[0] === "bash" || argv[0] === "sh") && argv[1] === "-c" && argv[2]) {
    words = argv[2].split(/\s+/).filter(Boolean);
    if (words[0] === "exec") words = words.slice(1);
    const redirect = words.indexOf("<");
    if (redirect !== -1) words = words.slice(0, redirect);
  }
  const binary = path.basename(words[0] ?? "");
  const rest = words.slice(1);
  const subcommand = rest[0] && !rest[0].startsWith("-") ? rest[0] : null;
  const flags: string[] = [];
  for (const word of rest) {
    if (word === "--") break;
    if (!word.startsWith("-") || word === "-") continue;
    const flag = word.split("=")[0]!;
    if (!flags.includes(flag)) flags.push(flag);
  }
  return { binary, subcommand, flags };
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The flags the help text does not mention as a flag. */
export function missingFlags(help: string, flags: string[]): string[] {
  return flags.filter(
    (flag) =>
      !new RegExp(
        `(^|[\\s,|\\[(])${escapeRegExp(flag)}(?=$|[\\s,=\\]|)<])`,
        "m",
      ).test(help),
  );
}

interface DoctorResult {
  harness: HarnessName;
  binary: string;
  version: string | null;
  helpArgv: string[];
  helpExit: number | null;
  flags: string[];
  missing: string[];
  ok: boolean;
}

interface DoctorRunner {
  run: Docker["run"];
}

export async function runDoctor(
  image: string,
  commandLines: DoctorCommandLine[],
  docker: DoctorRunner,
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const line of commandLines) {
    const parsed = parseCommandLine(line.argv);
    const helpArgv = [
      parsed.binary,
      ...(parsed.subcommand ? [parsed.subcommand] : []),
      "--help",
    ];
    const runOptions = {
      user: "dev",
      workdir: "/work",
      env: line.env,
      timeoutMs: 120_000,
    };
    let help: RunOutput;
    try {
      help = await docker.run(image, helpArgv, runOptions);
    } catch (error) {
      help = {
        code: null,
        stdout: [],
        stderr: [String((error as Error).message)],
      };
    }
    const helpText = [...help.stdout, ...help.stderr].join("\n");
    const missing =
      help.code === 0 ? missingFlags(helpText, parsed.flags) : parsed.flags;
    let version: string | null = null;
    try {
      const out = await docker.run(
        image,
        [parsed.binary, "--version"],
        runOptions,
      );
      version =
        out.code === 0 ? (out.stdout.find((l) => l.trim()) ?? null) : null;
    } catch {
      version = null;
    }
    results.push({
      harness: line.harness,
      binary: parsed.binary,
      version,
      helpArgv,
      helpExit: help.code,
      flags: parsed.flags,
      missing,
      ok: help.code === 0 && missing.length === 0,
    });
  }
  return results;
}

export function formatDoctor(results: DoctorResult[]): string[] {
  return results.map((result) => {
    const status = result.ok ? "ok  " : "FAIL";
    const version = result.version ? ` (${result.version})` : " (no --version)";
    const detail = result.ok
      ? `${result.flags.length} flags found in \`${result.helpArgv.join(" ")}\``
      : result.helpExit !== 0
        ? `\`${result.helpArgv.join(" ")}\` exited ${result.helpExit}`
        : `not in --help: ${result.missing.join(", ")}`;
    return `${status} ${result.harness.padEnd(8)} ${result.binary}${version}: ${detail}`;
  });
}

interface DoctorMainOptions {
  dockerfile: string;
  /** Every adapter's line by default. */
  commandLines?: DoctorCommandLine[];
  docker?: Docker;
  log?: (line: string) => void;
  /** Rebuild even when the tag exists. */
  rebuild?: boolean;
}

/** The command: resolve docker, build the image if its tag is missing, run every line, print. Returns the exit code. */
export async function doctorMain(options: DoctorMainOptions): Promise<number> {
  const log =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let docker = options.docker;
  if (!docker) {
    const binary = resolveDockerBinary();
    if (!binary) {
      log("docker: not found at Docker Desktop's paths or on PATH");
      return 1;
    }
    docker = createDocker({ binary });
  }
  const tag = imageTag(options.dockerfile);
  const info = await docker.info();
  log(
    `docker ${docker.binary}: engine ${info.engine}, ${info.os}/${info.arch}, ${info.ncpu} CPUs, ${(info.memBytes / 1024 ** 3).toFixed(2)} GiB`,
  );
  if (options.rebuild || !(await docker.imageExists(tag))) {
    log(`building ${tag} from ${options.dockerfile}`);
    const { ms } = await docker.build({
      dockerfile: options.dockerfile,
      context: path.dirname(options.dockerfile),
      tag,
    });
    log(`built ${tag} in ${Math.round(ms / 1000)} s`);
  }
  const size = await docker.imageSizeBytes(tag);
  log(`image ${tag}${size !== null ? `, ${(size / 1e9).toFixed(2)} GB` : ""}`);
  const results = await runDoctor(
    tag,
    options.commandLines ??
      commandLinesFrom(HARNESS_NAMES.map((name) => createHarness(name))),
    docker,
  );
  for (const line of formatDoctor(results)) log(line);
  return results.every((result) => result.ok) ? 0 : 1;
}
