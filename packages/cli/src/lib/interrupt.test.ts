import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { acquireLease, readLease } from "@/lib/gateway/lease";
import { createSqliteD1 } from "@/test/sqliteD1";
import { handleInterrupt, onInterrupt, trackChild } from "./interrupt";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("interrupts", () => {
  it("handle SIGINT and SIGTERM only while something needs cleaning up", () => {
    const before = process.listenerCount("SIGINT");
    const forget = onInterrupt({ sync: () => undefined });
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
    forget();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("stop cf's process group, then clean up and exit 130", async () => {
    // A cf child in its own group, with a child of its own (workerd, Vite).
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: "ignore" },
    );
    trackChild(child, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-interrupt-"));
    onInterrupt({ sync: () => fs.rmSync(dir, { recursive: true, force: true }) });
    const freed = vi.fn(async () => undefined);
    onInterrupt({ async: freed });
    const exit = vi.fn();

    await handleInterrupt("SIGINT", { exit });

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(freed).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("kill a cf child the interrupted code starts, never one a cleanup starts", async () => {
    const started: number[] = [];
    const sleeper = () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      started.push(child.pid!);
      return child;
    };
    try {
      let freeing: ReturnType<typeof sleeper> | undefined;
      // Freeing the lease runs a cf call of its own.
      onInterrupt({
        async: async () => {
          freeing = sleeper();
          trackChild(freeing, true);
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
      });

      const handling = handleInterrupt("SIGINT", { exit: vi.fn() });
      // Meanwhile a `finally` block in the interrupted deploy starts cf.
      const late = sleeper();
      trackChild(late, true);
      await waitFor(() => late.signalCode !== null);
      await handling;

      expect(late.signalCode).toBe("SIGKILL");
      expect(isAlive(freeing!.pid!)).toBe(true);
    } finally {
      for (const pid of started) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
    }
  });

  it("run the cleanups the interrupted code registers meanwhile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-interrupt-late-"));
    let freed!: () => void;
    onInterrupt({ async: () => new Promise<void>((resolve) => (freed = resolve)) });
    const exit = vi.fn();

    const handling = handleInterrupt("SIGTERM", { exit });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // While the lease is freed, the interrupted deploy writes its inputs.
    onInterrupt({ sync: () => fs.rmSync(dir, { recursive: true, force: true }) });
    freed();
    await handling;

    expect(fs.existsSync(dir)).toBe(false);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("run the asynchronous cleanups last registered first, one at a time", async () => {
    const steps: string[] = [];
    const slow = (name: string) => async () => {
      steps.push(`${name} starts`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      steps.push(`${name} ends`);
    };
    onInterrupt({ async: slow("free the lease") });
    onInterrupt({ async: slow("record the upload") });

    await handleInterrupt("SIGINT", { exit: vi.fn() });

    expect(steps).toEqual([
      "record the upload starts",
      "record the upload ends",
      "free the lease starts",
      "free the lease ends",
    ]);
  });

  it("go on cleaning up through a CI runner's SIGTERM, but not a second Ctrl+C", async () => {
    let finish!: () => void;
    const recorded = vi.fn();
    onInterrupt({
      async: () =>
        new Promise<void>((resolve) => (finish = resolve)).then(recorded),
    });
    const exit = vi.fn();

    const handling = handleInterrupt("SIGINT", { exit });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handleInterrupt("SIGTERM", { exit });
    expect(exit).not.toHaveBeenCalled();
    finish();
    await handling;
    expect(recorded).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(130);

    // A person pressing Ctrl+C again doesn't wait.
    await handleInterrupt("SIGINT", { exit });
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it("free a held deploy lease and remove a temporary file", async () => {
    const db = createSqliteD1();
    await acquireLease({ db, id: "gateway", purpose: "gateway.upgrade", heartbeatMs: 0 });
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-interrupt-app-"));
    const file = path.join(app, "secrets.json");
    fs.writeFileSync(file, "{}");
    onInterrupt({ sync: () => fs.rmSync(file, { force: true }) });

    await handleInterrupt("SIGTERM", { exit: vi.fn() });

    await expect(readLease(db, "gateway")).resolves.toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(app, { recursive: true, force: true });
  });

  it("forget what was cleaned up normally", async () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-interrupt-app-"));
    const forget = onInterrupt({ sync: () => fs.rmSync(app, { recursive: true, force: true }) });
    const before = process.listenerCount("SIGINT");
    forget();
    expect(process.listenerCount("SIGINT")).toBe(before - 1);
    fs.rmSync(app, { recursive: true, force: true });
  });

  it(
    "on Ctrl+C during `cf deploy`, stop cf and remove the secrets file before exiting",
    { timeout: 60_000 },
    async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-sigint-"));
      const marker = path.join(work, "cf-started.json");
      // Stands in for cf: answers the deployments lookup, then "deploys"
      // for a long time, saying where its secrets file is.
      const fakeCf = path.join(work, "fake-cf.mjs");
      fs.writeFileSync(
        fakeCf,
        `import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "workers") { process.stdout.write('{"deployments":[]}'); process.exit(0); }
const secrets = args[args.indexOf("--secrets-file") + 1];
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, secrets }));
setInterval(() => {}, 1000);
`,
      );
      const script = path.join(work, "deploy.mjs");
      fs.writeFileSync(
        script,
        `const { createJiti } = await import(${JSON.stringify(
          pathToFileURL(path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti.mjs")).href,
        )});
const jiti = createJiti(import.meta.url, { alias: { "@": ${JSON.stringify(SRC)} } });
const { createCfRunner } = await jiti.import(${JSON.stringify(path.join(SRC, "lib/cf/runner.ts"))});
const { cfDeploy } = await jiti.import(${JSON.stringify(path.join(SRC, "lib/cf/deploy.ts"))});
const cf = createCfRunner({ resolveBinary: async () => ({ path: ${JSON.stringify(fakeCf)}, version: "x", source: "cli" }) });
await cfDeploy({ cf, cwd: ${JSON.stringify(work)}, workerName: "every-app-gateway", accountId: "acct", message: "m", interactive: false,
  secrets: { BETTER_AUTH_SECRET: "super-secret", JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" } });
`,
      );
      const everyapp = spawn(process.execPath, [script], {
        env: { ...process.env, HOME: os.homedir() },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      everyapp.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) =>
        everyapp.once("close", (code) => resolve(code)),
      );
      try {
        await waitFor(() => fs.existsSync(marker), 30_000);
        const { pid, secrets } = JSON.parse(fs.readFileSync(marker, "utf8")) as {
          pid: number;
          secrets: string;
        };
        expect(fs.readFileSync(secrets, "utf8")).toContain("super-secret");

        // Ctrl+C reaches everyapp's process group, not cf's.
        everyapp.kill("SIGINT");

        expect(await exited).toBe(130);
        expect(stderr).toContain("Interrupted");
        await waitFor(() => !isAlive(pid));
        expect(fs.existsSync(secrets)).toBe(false);
      } finally {
        everyapp.kill("SIGKILL");
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
