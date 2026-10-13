import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolveCfBinary } from "./bin";
import { CfError, CfOutputError, CfTimeoutError } from "./errors";
import { makeCfTempDir } from "./privateDir";
import { createCfRunner, runCfJson, type CfRunnerOptions } from "./runner";

// A stand-in for the cf binary: a Node script whose behavior is the first
// argument. The runner spawns it exactly like the real cf.
const FAKE_CF = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [scenario, ...rest] = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1000);
switch (scenario) {
  case "discover": {
    // What cf does before most commands: the first cloudflare.config.ts in
    // the working directory or any parent.
    let config = null;
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "cloudflare.config.ts");
      if (fs.existsSync(candidate)) { config = candidate; break; }
      if (path.dirname(dir) === dir) break;
    }
    process.stdout.write(JSON.stringify({ cwd: process.cwd(), config }));
    break;
  }
  case "tools": {
    // What cf's children find on PATH: the Node and pnpm \`pnpm vite\` runs on.
    const { execFileSync } = require("node:child_process");
    const run = (file, args) => execFileSync(file, args, { encoding: "utf8" }).trim();
    process.stdout.write(JSON.stringify({
      node: run("node", ["-p", "process.execPath"]),
      pnpm: run("pnpm", ["--version"]),
    }));
    break;
  }
  case "env":
    process.stdout.write(JSON.stringify({
      cwd: process.cwd(),
      noColor: process.env.NO_COLOR ?? null,
      quiet: process.env.CF_QUIET ?? null,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
      extra: process.env.EXTRA ?? null,
    }));
    break;
  case "stdin": {
    let ended = false;
    process.stdin.on("end", () => (ended = true));
    process.stdin.resume();
    setTimeout(() => process.stdout.write(JSON.stringify({ ended })), 100);
    break;
  }
  case "hang-after-json": {
    // Like cf --local: a child keeps running and the result is printed, but
    // nothing ever exits.
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(rest[0], String(grandchild.pid));
    process.stdout.write('[{"name":"0000_init.sql","status":"ok"}]\n');
    forever();
    break;
  }
  case "hang-silent":
    forever();
    break;
  case "hang-partial":
    process.stdout.write('[{"name":');
    forever();
    break;
  case "json-then-exit":
    // Exits after the first quiet period would have ended, but output in
    // between restarts it.
    process.stdout.write("[]");
    setTimeout(() => process.stderr.write("still working\n"), 250);
    setTimeout(() => process.exit(0), 550);
    break;
  case "aborted":
    // A destructive command without --force, run without a terminal.
    process.stderr.write("? This permanently deletes the D1 database. Continue?\n  (non-interactive; pass --force to confirm)\nAborted.\n");
    break;
  case "fail":
    process.stderr.write("\n┌ Error\n│ Expected a D1 database ID, but received <database>=\"DB\".\n└\n");
    process.exit(1);
    break;
  case "not-json":
    process.stdout.write("Build complete");
    break;
  case "read-file": {
    const file = rest[0].replace(/^@/, "");
    const stat = fs.statSync(file);
    process.stdout.write(JSON.stringify({ file, content: fs.readFileSync(file, "utf-8"), mode: stat.mode & 0o777 }));
    if (rest[1] === "fail") process.exit(1);
    break;
  }
  case "serve":
    fs.writeFileSync(rest[0], String(process.pid));
    forever();
    break;
}
`;

let dir: string;
let options: CfRunnerOptions;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-cf-runner-"));
  const bin = path.join(dir, "fake-cf.cjs");
  await fs.writeFile(bin, FAKE_CF);
  options = {
    resolveBinary: async () => ({ path: bin, version: "0.0.0", source: "cli" }),
    watchdogIdleMs: 200,
  };
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const anyJson = z.unknown();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("createCfRunner", () => {
  it("runs account-plane calls in an empty directory with the account pinned", async () => {
    const cf = createCfRunner({ ...options, accountId: "acct_123" });
    const output = (await runCfJson(
      cf,
      { args: ["env"], plane: "account", env: { EXTRA: "1" } },
      anyJson,
    )) as Record<string, string | null>;

    expect(output["cwd"]).toBe(
      await fs.realpath(path.join(os.homedir(), ".everyapp", "cf", "neutral")),
    );
    expect(output).toMatchObject({
      noColor: "1",
      quiet: "1",
      accountId: "acct_123",
      extra: "1",
    });
  });

  it("runs project-plane calls in the app root", async () => {
    const cf = createCfRunner(options);
    const output = (await runCfJson(
      cf,
      { args: ["env"], plane: "project", cwd: dir },
      anyJson,
    )) as Record<string, string | null>;

    expect(output["cwd"]).toBe(await fs.realpath(dir));
    expect(output["accountId"]).toBeNull();
  });

  it("runs its own cf in a tree that isn't an app", async () => {
    const roots: Array<string | undefined> = [];
    const cf = createCfRunner({
      ...options,
      resolveBinary: async (root) => {
        roots.push(root);
        return options.resolveBinary!(root);
      },
    });
    await runCfJson(cf, { args: ["env"], plane: "project", cwd: dir }, anyJson);
    await runCfJson(cf, { args: ["env"], plane: "project", cwd: dir, cliCf: true }, anyJson);

    // An app's own cf, then never a node_modules/cf found above a release.
    expect(roots).toEqual([dir, undefined]);
  });

  it.runIf(process.platform !== "win32")(
    "gives cf's children this Node, whatever node a directory pins, and the same pnpm",
    async () => {
      // An nvm or volta pin puts an older node first; the user's pnpm too.
      const pinned = path.join(dir, "pinned-bin");
      await fs.mkdir(pinned, { recursive: true });
      await fs.writeFile(path.join(pinned, "node"), "#!/bin/sh\necho node-18\n", { mode: 0o755 });
      await fs.writeFile(path.join(pinned, "pnpm"), "#!/bin/sh\necho 10.34.5\n", { mode: 0o755 });
      const cf = createCfRunner({
        ...options,
        env: { ...process.env, PATH: `${pinned}${path.delimiter}${process.env["PATH"]}` },
      });

      const tools = (await runCfJson(
        cf,
        { args: ["tools"], plane: "project", cwd: dir },
        anyJson,
      )) as { node: string; pnpm: string };

      expect(await fs.realpath(tools.node)).toBe(await fs.realpath(process.execPath));
      expect(tools.pnpm).toBe("10.34.5");
    },
  );

  describe.runIf(process.platform !== "win32")("before cf build or dev", () => {
    // Like a Volta shim: what pnpm runs finds the project's pinned Node
    // first, whatever comes first on the PATH it was given.
    async function pinnedProject(nodeVersion: string) {
      const root = await fs.mkdtemp(path.join(dir, "pinned-"));
      const pinned = path.join(root, "pinned-node");
      const shims = path.join(root, "shims");
      const project = path.join(root, "app");
      for (const each of [pinned, shims, project]) await fs.mkdir(each);
      await fs.writeFile(path.join(pinned, "node"), `#!/bin/sh\necho ${nodeVersion}\n`, {
        mode: 0o755,
      });
      await fs.writeFile(
        path.join(shims, "pnpm"),
        `#!/bin/sh\nPATH="${pinned}:$PATH"\nexport PATH\n[ "$1" = exec ] && shift\nexec "$@"\n`,
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(project, "package.json"),
        JSON.stringify({ packageManager: "pnpm@10.34.5", volta: { node: nodeVersion } }),
      );
      const cf = createCfRunner({
        ...options,
        env: { ...process.env, PATH: `${shims}${path.delimiter}${process.env["PATH"]}` },
      });
      return { cf, project };
    }

    it("refuses a package manager that runs the project's tools on a Node too old for cf", async () => {
      const { cf, project } = await pinnedProject("20.11.0");

      await expect(
        cf.run({ args: ["build"], plane: "project", cwd: project, mode: "text" }),
      ).rejects.toMatchObject({
        code: "NODE_TOO_OLD",
        message: expect.stringContaining("pnpm runs this project's tools on Node.js 20.11.0"),
      });
      await expect(cf.start({ args: ["dev"], cwd: project })).rejects.toMatchObject({
        code: "NODE_TOO_OLD",
      });
    });

    it("builds when that Node is new enough", async () => {
      const { cf, project } = await pinnedProject("22.18.0");

      await expect(
        cf.run({ args: ["build"], plane: "project", cwd: project, mode: "text" }),
      ).resolves.toMatchObject({ stdout: "" });
    });
  });

  it("gives piped calls no stdin", async () => {
    const cf = createCfRunner(options);
    await expect(
      runCfJson(cf, { args: ["stdin"], plane: "account" }, anyJson),
    ).resolves.toEqual({ ended: true });
  });

  it("stops a --local call that printed its result but never exits, with its children", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    const cf = createCfRunner(options);
    const started = Date.now();

    const result = await cf.run({
      args: ["hang-after-json", pidFile],
      plane: "project",
      cwd: dir,
      mode: "json",
      local: true,
      timeoutMs: 10_000,
    });

    expect(result.stoppedByWatchdog).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: "0000_init.sql", status: "ok" },
    ]);
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(await fs.readFile(pidFile, "utf-8"));
    await waitUntil(() => !isAlive(grandchild));
  });

  it("keeps waiting while a --local call is still talking after its JSON", async () => {
    const cf = createCfRunner({ ...options, watchdogIdleMs: 400 });
    const result = await cf.run({
      args: ["json-then-exit"],
      plane: "account",
      mode: "json",
      local: true,
    });
    expect(result.stoppedByWatchdog).toBe(false);
    expect(result.stderr).toContain("still working");
  });

  it("times out a call that never prints a result", async () => {
    const cf = createCfRunner(options);
    await expect(
      cf.run({
        args: ["hang-silent"],
        plane: "account",
        mode: "json",
        local: true,
        timeoutMs: 500,
      }),
    ).rejects.toBeInstanceOf(CfTimeoutError);
  });

  it("does not mistake partial JSON for a finished result", async () => {
    const cf = createCfRunner(options);
    await expect(
      cf.run({
        args: ["hang-partial"],
        plane: "account",
        mode: "json",
        local: true,
        timeoutMs: 800,
      }),
    ).rejects.toThrow(/did not finish/);
  });

  it("turns a failed run into a typed CfError", async () => {
    const cf = createCfRunner(options);
    const error = await cf
      .run({ args: ["fail"], plane: "account", mode: "json" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CfError);
    expect(error).toMatchObject({
      kind: "d1_id_rejected",
      exitCode: 1,
      message: 'Expected a D1 database ID, but received <database>="DB".',
    });
  });

  it("fails a command that cf aborted instead of running", async () => {
    const cf = createCfRunner(options);
    await expect(
      cf.run({ args: ["aborted"], plane: "account", mode: "json" }),
    ).rejects.toMatchObject({ name: "CfError", kind: "aborted", exitCode: 0 });
  });

  it("rejects output that isn't the expected JSON", async () => {
    const cf = createCfRunner(options);
    await expect(
      runCfJson(cf, { args: ["not-json"], plane: "account" }, anyJson),
    ).rejects.toBeInstanceOf(CfOutputError);
    await expect(
      runCfJson(cf, { args: ["env"], plane: "account" }, z.array(z.string())),
    ).rejects.toBeInstanceOf(CfOutputError);
  });

  it("passes files through a private temp file and removes it, even on failure", async () => {
    const cf = createCfRunner(options);
    const output = (await runCfJson(
      cf,
      {
        args: (files) => ["read-file", `@${files["body.json"]}`],
        plane: "account",
        files: { "body.json": { sql: "SELECT 1" } },
      },
      anyJson,
    )) as { file: string; content: string; mode: number };

    expect(JSON.parse(output.content)).toEqual({ sql: "SELECT 1" });
    expect(output.mode).toBe(0o600);
    await expect(fs.access(output.file)).rejects.toThrow();

    let failedFile = "";
    await expect(
      cf.run({
        args: (files) => {
          failedFile = files["secrets.json"]!;
          return ["read-file", failedFile, "fail"];
        },
        plane: "account",
        mode: "json",
        files: { "secrets.json": '{"TOKEN":"x"}' },
      }),
    ).rejects.toBeInstanceOf(CfError);
    await expect(fs.access(failedFile)).rejects.toThrow();
  });

  it("never lets cf find a cloudflare.config.ts planted in the shared temp directory", async () => {
    // Anyone can write to /tmp: plant a config there, and the directory the
    // runner used to run cf in.
    const sharedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-shared-tmp-"));
    vi.stubEnv("TMPDIR", sharedTmp);
    try {
      await fs.writeFile(path.join(sharedTmp, "cloudflare.config.ts"), "export default {};");
      await fs.mkdir(path.join(sharedTmp, "everyapp-cf-neutral"));
      const cf = createCfRunner(options);
      const discover = async (call: { plane: "account" | "project"; cwd?: string }) =>
        (await runCfJson(
          cf,
          {
            ...call,
            args: (files) => ["discover", files["body.json"]!],
            files: { "body.json": { sql: "SELECT 1" } },
          },
          anyJson,
        )) as { cwd: string; config: string | null };

      // API commands, and a deploy from a private copy of a release.
      const account = await discover({ plane: "account" });
      const release = await makeCfTempDir("gateway-deploy-");
      const project = await discover({ plane: "project", cwd: release });

      for (const run of [account, project]) {
        expect(run.config).toBeNull();
        expect(run.cwd.startsWith(await fs.realpath(sharedTmp))).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(sharedTmp, { recursive: true, force: true });
    }
  });

  it("keeps the real cf from running a planted config", { timeout: 60_000 }, async () => {
    const sharedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-shared-tmp-"));
    const marker = path.join(sharedTmp, "planted-config-ran");
    await fs.writeFile(
      path.join(sharedTmp, "cloudflare.config.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.cwd());\nexport default {};\n`,
    );
    const env = { PATH: process.env["PATH"], HOME: os.homedir(), TMPDIR: sharedTmp };
    const binary = await resolveCfBinary();
    try {
      // Control: cf started below the shared temp directory runs the
      // planted config (before it even finds it has no credentials).
      const below = path.join(sharedTmp, "everyapp-cf-neutral");
      await fs.mkdir(below);
      spawnSync(process.execPath, [binary.path, "d1", "list", "--name", "x"], {
        cwd: below,
        env: { ...env, CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" },
        stdio: "ignore",
        timeout: 30_000,
      });
      expect(readFileSync(marker, "utf8")).toBe(await fs.realpath(below));
      await fs.rm(marker);

      // The runner, with that temp directory as TMPDIR, never runs it.
      vi.stubEnv("TMPDIR", sharedTmp);
      const cf = createCfRunner({
        accountId: "0123456789abcdef0123456789abcdef",
        env,
      });
      await expect(
        cf.run({
          plane: "account",
          mode: "json",
          args: (files) => ["d1", "query", "0123456789abcdef0123456789abcdef", "--body", `@${files["q.json"]}`],
          files: { "q.json": { sql: "SELECT 1" } },
          timeoutMs: 30_000,
        }),
      ).rejects.toMatchObject({ kind: "auth" });
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(sharedTmp, { recursive: true, force: true });
    }
  });

  it("starts a long-running process in its own group and stops it", async () => {
    const pidFile = path.join(dir, "serve.pid");
    const cf = createCfRunner(options);
    const server = await cf.start({ args: ["serve", pidFile], cwd: dir });
    await waitUntil(() => {
      try {
        return Number(readFileSync(pidFile, "utf-8")) > 0;
      } catch {
        return false;
      }
    });

    server.stop();
    await expect(server.exited).resolves.toMatchObject({ signal: "SIGTERM" });
  });
});
