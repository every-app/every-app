/**
 * The Sandbox on Docker Desktop (design 3, 4.2 step 3, 4.3): one container
 * per run from the everyapp-loop image, created with the secrets in a 600
 * env file that is deleted the moment the container exists, every exec as
 * `dev` with its output streamed line by line through the redactor. Nothing
 * here knows the CLI or a harness; a Modal shim with the same interface
 * could replace this file and nothing else changes.
 *
 * The docker binary is not on PATH in Ben's fish shell: resolveDockerBinary
 * probes Docker Desktop's two paths, then PATH. Its directory is prepended
 * to PATH for every call, because the client runs `docker-credential-desktop`
 * from there and fails `docker build` without it (seen 2026-10-24).
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeSecretEnvFile, writeSecretEnvFile } from "./sandbox";
import { capture, spawnProcess, type Spawn, type SpawnOptions } from "./spawn";
import type {
  DiffEntry,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxHandle,
  SandboxSpec,
  TailHandle,
} from "./types";

/** Where Docker Desktop puts its client, in the order probed; `~` is the home directory. */
export const DOCKER_CANDIDATES = [
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "~/.docker/bin/docker",
];

interface ResolveDeps {
  isExecutable: (file: string) => boolean;
  home: string;
  pathEnv: string;
}

const defaultResolveDeps = (): ResolveDeps => ({
  isExecutable: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
  home: os.homedir(),
  pathEnv: process.env["PATH"] ?? "",
});

/** The docker client: Docker Desktop's paths first, then `command -v docker` by hand. */
export function resolveDockerBinary(
  deps: ResolveDeps = defaultResolveDeps(),
): string | null {
  for (const candidate of DOCKER_CANDIDATES) {
    const file = candidate.replace(/^~/, deps.home);
    if (deps.isExecutable(file)) return file;
  }
  for (const dir of deps.pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, "docker");
    if (deps.isExecutable(file)) return file;
  }
  return null;
}

/** The image tag is a hash of the Dockerfile: a pin bump is a new tag. */
export function imageTag(dockerfile: string): string {
  const hash = createHash("sha256")
    .update(fs.readFileSync(dockerfile))
    .digest("hex");
  return `everyapp-loop:${hash.slice(0, 12)}`;
}

export interface DockerInfo {
  engine: string;
  memBytes: number;
  ncpu: number;
  os: string;
  arch: string;
}

export interface RunOptions {
  user?: string;
  workdir?: string;
  /** Plain variables on the command line; never a secret (use the Sandbox for those). */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunOutput {
  code: number | null;
  stdout: string[];
  stderr: string[];
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string[],
  ) {
    super(message);
    this.name = "DockerError";
  }
}

interface DockerDeps {
  binary: string;
  spawn?: Spawn;
  /** Every line of every docker process goes through it before anyone sees it. */
  redact?: (text: string) => string;
}

/** The docker client, typed for what the loop needs, plus the Sandbox over it. */
export interface Docker {
  binary: string;
  info(): Promise<DockerInfo>;
  /** Names of containers whose name starts with `prefix`: every state, or only the stopped ones (exited, created, dead). */
  listContainers(prefix: string, which?: "all" | "stopped"): Promise<string[]>;
  removeContainers(names: string[]): Promise<void>;
  imageExists(tag: string): Promise<boolean>;
  imageSizeBytes(tag: string): Promise<number | null>;
  build(options: {
    dockerfile: string;
    context: string;
    tag: string;
    onLine?: (line: string) => void;
  }): Promise<{ ms: number }>;
  /** `docker run --rm <image> <argv>`, output captured (doctor's --help, the clock). */
  run(image: string, argv: string[], options?: RunOptions): Promise<RunOutput>;
  /** The container's clock in seconds since the epoch, against the host's. */
  clockSkewSeconds(image: string): Promise<number>;
  /** `docker stats --no-stream`: the container's memory in MiB now, or null when it cannot be read. */
  memoryMiB(name: string): Promise<number | null>;
  sandbox: Sandbox;
}

/** "123.4MiB / 6GiB" (docker's MemUsage column) to MiB; null when it does not parse. */
export function parseMemUsageMiB(text: string): number | null {
  const match = /^\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const scale: Record<string, number> = {
    B: 1 / 1024 ** 2,
    KB: 1 / 1024,
    KIB: 1 / 1024,
    MB: 1,
    MIB: 1,
    GB: 1024,
    GIB: 1024,
    TB: 1024 ** 2,
    TIB: 1024 ** 2,
  };
  const factor = scale[unit];
  if (factor === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * factor * 10) / 10;
}

export function createDocker(deps: DockerDeps): Docker {
  const spawn = deps.spawn ?? spawnProcess;
  const redact = deps.redact ?? ((text: string) => text);
  const binDir = path.dirname(deps.binary);

  const docker: DockerSpawn = (args, { raw, ...options } = {}) => {
    const clean = raw ? (line: string) => line : redact;
    return spawn(deps.binary, args, {
      ...options,
      env: {
        ...process.env,
        ...options.env,
        PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      },
      onStdout: options.onStdout && ((line) => options.onStdout?.(clean(line))),
      onStderr: options.onStderr && ((line) => options.onStderr?.(clean(line))),
    });
  };

  /** Runs and keeps the output; a non-zero exit is an error that quotes stderr. */
  const dockerCapture = async (
    args: string[],
    options: Omit<SpawnOptions, "onStdout" | "onStderr"> = {},
  ): Promise<RunOutput> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await docker(args, {
      ...options,
      onStdout: (line) => stdout.push(line),
      onStderr: (line) => stderr.push(line),
    });
    if (result.code !== 0) {
      throw new DockerError(
        `docker ${args.slice(0, 2).join(" ")} exited ${result.code ?? result.signal}: ${stderr.join(" ").slice(0, 500)}`,
        args,
        result.code,
        stderr,
      );
    }
    return { code: result.code, stdout, stderr };
  };

  const sandbox = new DockerSandbox(docker, dockerCapture);

  return {
    binary: deps.binary,
    async info() {
      const { stdout } = await dockerCapture([
        "info",
        "--format",
        "{{json .}}",
      ]);
      const info = JSON.parse(stdout.join("")) as Record<string, unknown>;
      return {
        engine: String(info["ServerVersion"] ?? ""),
        memBytes: Number(info["MemTotal"] ?? 0),
        ncpu: Number(info["NCPU"] ?? 0),
        os: String(info["OSType"] ?? ""),
        arch: String(info["Architecture"] ?? ""),
      };
    },
    async listContainers(prefix, which = "all") {
      // Several `status=` filters on one `docker ps` are OR'ed.
      const status =
        which === "stopped"
          ? ["exited", "created", "dead"].flatMap((s) => [
              "--filter",
              `status=${s}`,
            ])
          : [];
      const { stdout } = await dockerCapture([
        "ps",
        "-a",
        "--filter",
        `name=^${prefix}`,
        ...status,
        "--format",
        "{{.Names}}",
      ]);
      return stdout.filter((name) => name.startsWith(prefix));
    },
    async removeContainers(names) {
      if (names.length === 0) return;
      await dockerCapture(["rm", "-f", ...names]);
    },
    async imageExists(tag) {
      const result = await docker([
        "image",
        "inspect",
        tag,
        "--format",
        "{{.Id}}",
      ]);
      return result.code === 0;
    },
    async imageSizeBytes(tag) {
      const result = await capture(
        spawn,
        deps.binary,
        ["image", "inspect", tag, "--format", "{{.Size}}"],
        {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
          },
        },
      );
      if (result.code !== 0) return null;
      const size = Number(result.stdout[0]);
      return Number.isFinite(size) ? size : null;
    },
    async build({ dockerfile, context, tag, onLine }) {
      const startedAt = Date.now();
      const stderr: string[] = [];
      const result = await docker(
        ["build", "--progress=plain", "-t", tag, "-f", dockerfile, context],
        {
          onStdout: (line) => onLine?.(line),
          onStderr: (line) => {
            stderr.push(line);
            onLine?.(line);
          },
        },
      );
      if (result.code !== 0) {
        throw new DockerError(
          `docker build of ${tag} failed (exit ${result.code}); last lines:\n${stderr.slice(-15).join("\n")}`,
          ["build", tag],
          result.code,
          stderr,
        );
      }
      return { ms: Date.now() - startedAt };
    },
    async run(image, argv, options = {}) {
      const args = [
        "run",
        "--rm",
        "-i",
        ...(options.user ? ["-u", options.user] : []),
        ...(options.workdir ? ["-w", options.workdir] : []),
        ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
          "-e",
          `${key}=${value}`,
        ]),
        image,
        ...argv,
      ];
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await docker(args, {
        stdin: options.stdin,
        onStdout: (line) => stdout.push(line),
        onStderr: (line) => stderr.push(line),
      });
      return { code: result.code, stdout, stderr };
    },
    async clockSkewSeconds(image) {
      const before = Date.now() / 1000;
      const { stdout } = await dockerCapture([
        "run",
        "--rm",
        image,
        "date",
        "+%s",
      ]);
      const after = Date.now() / 1000;
      const container = Number(stdout[0]);
      if (!Number.isFinite(container))
        throw new Error(`The container's clock read "${stdout[0]}".`);
      return container - (before + after) / 2;
    },
    async memoryMiB(name) {
      const result = await capture(
        spawn,
        deps.binary,
        ["stats", "--no-stream", "--format", "{{.MemUsage}}", name],
        {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
          },
        },
      );
      if (result.code !== 0) return null;
      return parseMemUsageMiB(result.stdout[0] ?? "");
    },
    sandbox,
  };
}

/** `raw` skips the redaction of streamed lines; only `exec` with `rawLines` asks for it. */
type DockerSpawn = (
  args: string[],
  options?: SpawnOptions & { raw?: boolean },
) => ReturnType<Spawn>;
type DockerCapture = (
  args: string[],
  options?: Omit<SpawnOptions, "onStdout" | "onStderr">,
) => Promise<RunOutput>;

/**
 * The signal behind an exit code after the driver killed the group:
 * `setsid -w` returns the signal number itself (9, 15) where a shell would
 * return 128 + it (137, 143). Seen live on the image, 2026-10-24.
 */
function signalOf(code: number | null): string | null {
  switch (code) {
    case 9:
    case 137:
      return "SIGKILL";
    case 15:
    case 143:
      return "SIGTERM";
    default:
      return null;
  }
}

/** How long a process gets between SIGTERM and SIGKILL when the driver ends it. */
const GRACE_MS = 5_000;

class DockerSandbox implements Sandbox {
  /** What each container was created with, for the user and workdir of its execs. */
  private readonly specs = new Map<string, SandboxSpec>();

  constructor(
    private readonly docker: DockerSpawn,
    private readonly dockerCapture: DockerCapture,
  ) {}

  /**
   * `docker create` with the limits from the design and the secrets in an
   * env file this user alone can read, deleted once the container exists;
   * then `docker start`. No socket, no mounts. A workdir that does not
   * exist is made by docker as root: pass one that exists in the image
   * (/work) and give each exec its own `cwd`.
   */
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.specs.set(spec.name, spec);
    const envFile = writeSecretEnvFile(spec.env);
    let id: string;
    try {
      const { stdout } = await this.dockerCapture([
        "create",
        "--name",
        spec.name,
        "--platform",
        spec.platform,
        "--cpus",
        String(spec.cpus),
        "--memory",
        spec.memory,
        "--pids-limit",
        "4096",
        "--init",
        "-u",
        spec.user,
        "-w",
        spec.workdir,
        "--env-file",
        envFile,
        spec.image,
        "sleep",
        "infinity",
      ]);
      id = stdout[0] ?? spec.name;
    } finally {
      removeSecretEnvFile(envFile);
    }
    await this.dockerCapture(["start", spec.name]);
    return { id, name: spec.name };
  }

  /**
   * `docker cp` keeps the host file's mode and makes root the owner, so a
   * 600 file from the driver's temp dir is unreadable by the sandbox's user
   * (seen live: "bash: /loop/script.sh: Permission denied"). Hand it to that
   * user afterwards.
   */
  async copyIn(
    handle: SandboxHandle,
    hostPath: string,
    sandboxPath: string,
  ): Promise<void> {
    await this.dockerCapture(["cp", hostPath, `${handle.name}:${sandboxPath}`]);
    const user = this.specs.get(handle.name)?.user ?? "dev";
    await this.dockerCapture([
      "exec",
      "-u",
      "root",
      handle.name,
      "chown",
      "-R",
      `${user}:${user}`,
      sandboxPath,
    ]);
  }

  /**
   * `docker exec` as the sandbox's user, stdin at EOF, each line stamped and
   * redacted. The command runs under `setsid` with its pid in a file, so a
   * timeout or the AbortSignal kills the whole process group inside the
   * container (killing the docker client would leave it running).
   */
  async exec(
    handle: SandboxHandle,
    argv: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const spec = this.specs.get(handle.name);
    const user = spec?.user ?? "dev";
    const cwd = options.cwd ?? spec?.workdir;
    const pidfile = `/tmp/loop-exec-${randomUUID().slice(0, 8)}.pid`;
    const args = [
      "exec",
      "-i",
      "-u",
      user,
      ...(cwd ? ["-w", cwd] : []),
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]),
      handle.name,
      "setsid",
      "-w",
      "bash",
      "-c",
      'echo $$ > "$0"; exec "$@"',
      pidfile,
      ...argv,
    ];

    let killed = false;
    const kill = (signal: "TERM" | "KILL") =>
      this.docker([
        "exec",
        "-u",
        user,
        handle.name,
        "bash",
        "-c",
        `p=$(cat ${pidfile} 2>/dev/null) && kill -${signal} -- -"$p" 2>/dev/null; true`,
      ]).catch(() => undefined);
    const end = (): void => {
      if (killed) return;
      killed = true;
      void kill("TERM")
        .then(() => new Promise((resolve) => setTimeout(resolve, GRACE_MS)))
        .then(() => kill("KILL"));
    };
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(end, options.timeoutMs)
        : null;
    options.signal?.addEventListener("abort", end, { once: true });

    const startedAt = Date.now();
    const onLine = options.onLine;
    const stamp = (stream: "stdout" | "stderr") => (line: string) =>
      onLine?.({
        stream,
        line,
        receivedAt: new Date().toISOString(),
      });
    try {
      const result = await this.docker(args, {
        raw: options.rawLines === true,
        onStdout: stamp("stdout"),
        onStderr: stamp("stderr"),
      });
      const code = result.code;
      return {
        exitCode: code,
        signal: result.signal ?? (killed ? signalOf(code) : null),
        durationMs: Date.now() - startedAt,
        killed,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", end);
    }
  }

  /** `tail -n +1 -F` inside the container; close() kills the tail. A file that does not exist yet is waited for. */
  async tailFile(
    handle: SandboxHandle,
    sandboxPath: string,
    onLine: (line: string) => void,
  ): Promise<TailHandle> {
    const controller = new AbortController();
    const done = this.exec(handle, ["tail", "-n", "+1", "-F", sandboxPath], {
      signal: controller.signal,
      // Raw: the claimer reads the owner link's token from these lines; run.ts redacts what it writes.
      rawLines: true,
      onLine: (line) => {
        if (line.stream === "stdout") onLine(line.line);
      },
    }).catch(() => undefined);
    return {
      close: async () => {
        controller.abort();
        await done;
      },
    };
  }

  async copyOut(
    handle: SandboxHandle,
    sandboxPath: string,
    hostPath: string,
  ): Promise<void> {
    await this.dockerCapture(["cp", `${handle.name}:${sandboxPath}`, hostPath]);
  }

  /** `docker diff`: A added, C changed, D deleted. */
  async diff(handle: SandboxHandle): Promise<DiffEntry[]> {
    const { stdout } = await this.dockerCapture(["diff", handle.name]);
    return stdout.flatMap((line) => {
      const match = /^([ACD]) (.+)$/.exec(line);
      if (!match) return [];
      const kind =
        match[1] === "A" ? "added" : match[1] === "C" ? "changed" : "deleted";
      return [{ kind, path: match[2]! }];
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.dockerCapture(["rm", "-f", handle.name]);
    this.specs.delete(handle.name);
  }
}
