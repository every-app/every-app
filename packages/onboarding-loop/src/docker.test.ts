import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDocker,
  DOCKER_CANDIDATES,
  DockerError,
  imageTag,
  parseMemUsageMiB,
  resolveDockerBinary,
} from "./docker";
import { createFakeSpawn, type FakeAnswer, type FakeCall } from "./spawn";
import type { SandboxSpec } from "./types";

const BIN = "/Applications/Docker.app/Contents/Resources/bin/docker";
const TOKEN = "fake-token-abcdefghijklmnopqrstuv";

const spec: SandboxSpec = {
  name: "loop-run1",
  image: "everyapp-loop:abc",
  platform: "linux/arm64",
  cpus: 4,
  memory: "6g",
  env: {
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    EVERYAPP_EVENT_LOG: "/loop/e.ndjson",
  },
  user: "dev",
  workdir: "/work",
};

const setup = (
  script: (call: FakeCall) => FakeAnswer | undefined = () => undefined,
) => {
  const fake = createFakeSpawn(script);
  const docker = createDocker({
    binary: BIN,
    spawn: fake.spawn,
    redact: (text) => text.replaceAll(TOKEN, "[REDACTED:cf_token]"),
  });
  return { ...fake, docker };
};

describe("resolveDockerBinary", () => {
  it("probes Docker Desktop's paths, then PATH, then gives up", () => {
    const home = "/Users/ben";
    const deps = (files: string[]) => ({
      isExecutable: (file: string) => files.includes(file),
      home,
      pathEnv: "/opt/bin:/usr/bin",
    });
    expect(resolveDockerBinary(deps([DOCKER_CANDIDATES[0]!]))).toBe(
      DOCKER_CANDIDATES[0],
    );
    expect(resolveDockerBinary(deps([`${home}/.docker/bin/docker`]))).toBe(
      `${home}/.docker/bin/docker`,
    );
    expect(resolveDockerBinary(deps(["/opt/bin/docker"]))).toBe(
      "/opt/bin/docker",
    );
    expect(resolveDockerBinary(deps([]))).toBeNull();
  });

  it("the image tag is a hash of the Dockerfile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-dockerfile-"));
    const file = path.join(dir, "Dockerfile");
    fs.writeFileSync(file, "FROM node:22-bookworm\n");
    const tag = imageTag(file);
    expect(tag).toMatch(/^everyapp-loop:[0-9a-f]{12}$/);
    fs.writeFileSync(file, "FROM node:22-bookworm\nRUN true\n");
    expect(imageTag(file)).not.toBe(tag);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("createDocker", () => {
  it("puts the client's directory first on PATH for every call (docker-credential-desktop lives there)", async () => {
    const { docker, calls } = setup(() => ({
      stdout: [
        '{"ServerVersion":"29.8.2","MemTotal":8317267968,"NCPU":18,"OSType":"linux","Architecture":"aarch64"}',
      ],
    }));
    expect(await docker.info()).toEqual({
      engine: "29.8.2",
      memBytes: 8317267968,
      ncpu: 18,
      os: "linux",
      arch: "aarch64",
    });
    expect(calls[0]?.bin).toBe(BIN);
    expect(calls[0]?.env?.["PATH"]?.startsWith(`${path.dirname(BIN)}:`)).toBe(
      true,
    );
  });

  it("lists and removes stale loop-* containers", async () => {
    const { docker, calls } = setup((call) =>
      call.args[0] === "ps"
        ? { stdout: ["loop-old", "loop-sib-x"] }
        : undefined,
    );
    const stale = await docker.listContainers("loop-");
    expect(stale).toEqual(["loop-old", "loop-sib-x"]);
    await docker.removeContainers(stale);
    expect(calls[1]?.args).toEqual(["rm", "-f", "loop-old", "loop-sib-x"]);
    await docker.removeContainers([]);
    expect(calls).toHaveLength(2);
  });

  it("a failing docker command is a DockerError quoting stderr", async () => {
    const { docker } = setup(() => ({
      code: 1,
      stderr: ["Error response from daemon: no such image"],
    }));
    await expect(docker.listContainers("loop-")).rejects.toThrow(DockerError);
    await expect(docker.listContainers("loop-")).rejects.toThrow(
      /no such image/,
    );
  });

  it("reads a container's memory from docker stats, in MiB", async () => {
    expect(parseMemUsageMiB("123.4MiB / 6GiB")).toBe(123.4);
    expect(parseMemUsageMiB("1.5GiB / 6GiB")).toBe(1536);
    expect(parseMemUsageMiB("512KiB / 6GiB")).toBe(0.5);
    expect(parseMemUsageMiB("")).toBeNull();
    const { docker, calls } = setup((call) =>
      call.args[0] === "stats" ? { stdout: ["2.25GiB / 6GiB"] } : undefined,
    );
    expect(await docker.memoryMiB("loop-run1")).toBe(2304);
    expect(calls.at(-1)?.args).toEqual([
      "stats",
      "--no-stream",
      "--format",
      "{{.MemUsage}}",
      "loop-run1",
    ]);
  });

  it("the clock skew is the container's seconds against the host's", async () => {
    const { docker } = setup(() => ({
      stdout: [String(Math.floor(Date.now() / 1000) + 120)],
    }));
    const skew = await docker.clockSkewSeconds("everyapp-loop:abc");
    expect(skew).toBeGreaterThan(118);
    expect(skew).toBeLessThan(122);
  });
});

describe("DockerSandbox", () => {
  it("creates with the design's limits, the secrets in an env file it deletes after create, then starts", async () => {
    let envFile = "";
    let contentAtCreate = "";
    const { docker, calls } = setup((call) => {
      if (call.args[0] === "create") {
        envFile = call.args[call.args.indexOf("--env-file") + 1]!;
        contentAtCreate = fs.readFileSync(envFile, "utf8");
        expect((fs.statSync(envFile).mode & 0o777).toString(8)).toBe("600");
        return { stdout: ["cid123"] };
      }
      return undefined;
    });
    const handle = await docker.sandbox.create(spec);
    expect(handle).toEqual({ id: "cid123", name: "loop-run1" });
    const create = calls[0]!.args;
    expect(create.slice(0, 3)).toEqual(["create", "--name", "loop-run1"]);
    for (const flag of [
      "--platform",
      "linux/arm64",
      "--cpus",
      "4",
      "--memory",
      "6g",
      "--pids-limit",
      "4096",
      "--init",
      "-u",
      "dev",
      "-w",
      "/work",
    ]) {
      expect(create).toContain(flag);
    }
    expect(create.slice(-3)).toEqual([
      "everyapp-loop:abc",
      "sleep",
      "infinity",
    ]);
    expect(create.join(" ")).not.toContain(TOKEN);
    expect(contentAtCreate).toContain(`CLOUDFLARE_API_TOKEN=${TOKEN}`);
    expect(fs.existsSync(envFile)).toBe(false);
    expect(calls[1]?.args).toEqual(["start", "loop-run1"]);
  });

  it("execs as the sandbox's user in the given cwd under setsid with a pid file, lines stamped and redacted", async () => {
    const { docker, calls } = setup((call) =>
      call.args[0] === "exec"
        ? { stdout: [`token=${TOKEN}`, "done"], stderr: ["warn"], code: 0 }
        : undefined,
    );
    const handle = await docker.sandbox.create(spec);
    const lines: Array<{ stream: string; line: string }> = [];
    const result = await docker.sandbox.exec(handle, ["pnpm", "install"], {
      cwd: "/work/every-app",
      env: { DISABLE_AUTOUPDATER: "1" },
      onLine: (line) => {
        expect(line.receivedAt).toMatch(/^\d{4}-/);
        lines.push({ stream: line.stream, line: line.line });
      },
    });
    expect(result).toMatchObject({ exitCode: 0, signal: null, killed: false });
    const args = calls.at(-1)!.args;
    expect(args.slice(0, 8)).toEqual([
      "exec",
      "-i",
      "-u",
      "dev",
      "-w",
      "/work/every-app",
      "-e",
      "DISABLE_AUTOUPDATER=1",
    ]);
    expect(args[8]).toBe("loop-run1");
    expect(args.slice(9, 13)).toEqual(["setsid", "-w", "bash", "-c"]);
    expect(args[13]).toBe('echo $$ > "$0"; exec "$@"');
    expect(args[14]).toMatch(/^\/tmp\/loop-exec-[0-9a-f]{8}\.pid$/);
    expect(args.slice(15)).toEqual(["pnpm", "install"]);
    expect(lines).toEqual([
      { stream: "stdout", line: "token=[REDACTED:cf_token]" },
      { stream: "stdout", line: "done" },
      { stream: "stderr", line: "warn" },
    ]);
  });

  it("a timeout kills the process group inside the container, not the docker client", async () => {
    const { docker, calls } = setup((call) =>
      call.args.includes("setsid") ? { delayMs: 60, code: 143 } : undefined,
    );
    const handle = await docker.sandbox.create(spec);
    const result = await docker.sandbox.exec(handle, ["sleep", "100"], {
      timeoutMs: 10,
    });
    expect(result).toMatchObject({
      exitCode: 143,
      signal: "SIGTERM",
      killed: true,
    });
    // setsid -w reports a signal death as the signal number itself (seen live: 9 after the KILL).
    const killedHard = setup((call) =>
      call.args.includes("setsid") ? { delayMs: 60, code: 9 } : undefined,
    );
    const hard = await killedHard.docker.sandbox.exec(
      await killedHard.docker.sandbox.create(spec),
      ["sleep", "100"],
      { timeoutMs: 10 },
    );
    expect(hard).toMatchObject({
      exitCode: 9,
      signal: "SIGKILL",
      killed: true,
    });
    const kill = calls.find(
      (call) =>
        call.args[0] === "exec" && call.args.at(-1)?.includes("kill -TERM"),
    );
    expect(kill).toBeDefined();
    expect(kill!.args.slice(0, 4)).toEqual(["exec", "-u", "dev", "loop-run1"]);
    expect(kill!.args.at(-1)).toMatch(/kill -TERM -- -"\$p"/);
  });

  it("tailFile runs tail -n +1 -F and close() aborts it", async () => {
    const { docker, calls } = setup((call) =>
      call.args.includes("tail")
        ? { stdout: ['{"type":"invocation"}'], delayMs: 20 }
        : undefined,
    );
    const handle = await docker.sandbox.create(spec);
    const seen: string[] = [];
    const tail = await docker.sandbox.tailFile(
      handle,
      "/loop/everyapp-events.ndjson",
      (line) => seen.push(line),
    );
    await tail.close();
    expect(seen).toEqual(['{"type":"invocation"}']);
    const tailCall = calls.find((call) => call.args.includes("tail"))!;
    expect(tailCall.args.slice(-5)).toEqual([
      "tail",
      "-n",
      "+1",
      "-F",
      "/loop/everyapp-events.ndjson",
    ]);
    expect(tailCall.args.at(-1)).toBe("/loop/everyapp-events.ndjson");
  });

  it("copies in and out, parses docker diff, and removes the container", async () => {
    const { docker, calls } = setup((call) =>
      call.args[0] === "diff"
        ? {
            stdout: [
              "A /work/every-app/apps/hello",
              "C /home/dev/.claude",
              "D /tmp/x",
              "garbage",
            ],
          }
        : undefined,
    );
    const handle = await docker.sandbox.create(spec);
    await docker.sandbox.copyIn(
      handle,
      "/tmp/launch.bundle",
      "/loop/launch.bundle",
    );
    expect(calls.at(-1)?.args).toEqual([
      "cp",
      "/tmp/launch.bundle",
      "loop-run1:/loop/launch.bundle",
    ]);
    await docker.sandbox.copyOut(handle, "/loop", "/tmp/run/loop");
    expect(calls.at(-1)?.args).toEqual([
      "cp",
      "loop-run1:/loop",
      "/tmp/run/loop",
    ]);
    expect(await docker.sandbox.diff(handle)).toEqual([
      { kind: "added", path: "/work/every-app/apps/hello" },
      { kind: "changed", path: "/home/dev/.claude" },
      { kind: "deleted", path: "/tmp/x" },
    ]);
    await docker.sandbox.destroy(handle);
    expect(calls.at(-1)?.args).toEqual(["rm", "-f", "loop-run1"]);
  });
});
