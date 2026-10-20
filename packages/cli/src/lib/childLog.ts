/**
 * The children everyapp runs itself (pnpm, the manifest's install and build
 * commands, git, the Gateway's release build) write to a log file, never to
 * stdout, which --json keeps for events alone:
 * `$TMPDIR/everyapp/<command>-<time>.log`. When one fails, the error says
 * what ran, its last 20 lines and where the whole log is. With `echo`
 * (--verbose) the output goes to stderr too, as it comes.
 *
 * cf's own output never comes here: the runner keeps it in memory
 * (lib/cf/runner.ts), and a CfError carries its last lines.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { EveryAppError } from "@/lib/errors";
import { outputTail } from "@/lib/output/text";

interface RunLoggedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** `command` is a shell command line (a manifest's install or build). */
  shell?: boolean;
  /** Stream the output to stderr as well (--verbose). */
  echo?: boolean;
  /** What it does, for the error: "Installing dependencies". */
  what: string;
  /** The error's code (default COMMAND_FAILED). */
  code?: string;
  /** What to do when it fails ("fix the build error above, then run setup again"). */
  fix?: string;
  /** The log file's name, before its time ("gateway-build"); else the command's. */
  logName?: string;
}

/** Run a child with its output in a log file; throws EveryAppError when it fails. */
export async function runLogged(
  command: string,
  args: readonly string[],
  options: RunLoggedOptions,
): Promise<void> {
  const commandLine = [command, ...args].join(" ");
  const file = await newLogFile(options.logName ?? commandLine);
  const log = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
  const header = `$ ${commandLine}\n# in ${options.cwd ?? process.cwd()}\n\n`;
  log.write(header);
  const record = (chunk: Buffer) => {
    log.write(chunk);
    if (options.echo) process.stderr.write(chunk);
  };

  const child = execa(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    buffer: false,
    reject: false,
  });
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const result = await child;
  await new Promise<void>((resolve) => log.end(resolve));
  if (!result.failed) return;

  // The child's own lines: not the header this wrote above them.
  const tail = await lastLines(file, header.length);
  const why =
    result.exitCode !== undefined
      ? `exit code ${result.exitCode}`
      : result.signal
        ? `stopped by ${result.signal}`
        : result.shortMessage;
  throw new EveryAppError(
    options.code ?? "COMMAND_FAILED",
    [`${options.what} failed (${why})`, ...tail, `Full log: ${file}`].join("\n"),
    {
      ...(options.fix ? { fix: options.fix } : {}),
      data: { command: commandLine, log: file },
    },
  );
}

/** A new private log file under $TMPDIR/everyapp, named after `name`'s first two words. */
async function newLogFile(name: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "everyapp");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const base =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => path.basename(word).replace(/[^\w.-]+/g, ""))
      .filter(Boolean)
      .join("-") || "command";
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${base}-${time}-${process.pid}.log`);
}

async function lastLines(file: string, skip: number): Promise<string[]> {
  return outputTail((await fsp.readFile(file, "utf8").catch(() => "")).slice(skip));
}
