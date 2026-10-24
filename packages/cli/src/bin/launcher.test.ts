/**
 * bin/everyapp.js, the committed launcher, run as a child against a copy of
 * the checkout's layout: a `pnpm` on PATH that stands in for the real one
 * records each rebuild and writes dist/ as tsup would (cleaning it first).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/everyapp.js");

const FAKE_PNPM = `#!/usr/bin/env node
// Stands in for pnpm: records the call, takes a moment so two launchers
// overlap, then writes dist/ as tsup would, cleaning it first.
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.LAUNCHER_TEST_LOG, \`\${path.basename(process.cwd())}: \${process.argv.slice(2).join(" ")}\\n\`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync(path.join("dist", "index.js"), 'process.stdout.write("ran\\\\n");\\n');
`;

const FAILING_PNPM = `#!/usr/bin/env node
// Stands in for a pnpm whose build fails, as tsup does on a broken src/:
// records the call, says what went wrong, exits 1 and writes no dist/.
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.LAUNCHER_TEST_LOG, \`\${path.basename(process.cwd())}: \${process.argv.slice(2).join(" ")}\\n\`);
process.stderr.write("Error: Unexpected token in src/index.ts\\n");
process.exit(1);
`;

/** A pid no process has: above every platform's limit. */
const NO_SUCH_PID = 2_147_483_647;

interface Checkout {
  root: string;
  cliDir: string;
  lockDir: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A checkout whose SDK is built and whose CLI isn't: packages/cli with the
 * launcher and a source file, packages/sdk with a source file and a dist/
 * newer than it. `pnpm` is the script that stands in for pnpm on PATH.
 */
function checkout({ pnpm = FAKE_PNPM }: { pnpm?: string } = {}): Checkout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-launcher-")));
  dirs.push(root);
  const cliDir = path.join(root, "packages", "cli");
  const sdkDir = path.join(root, "packages", "sdk");
  const write = (file: string, content: string, agoMs: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const at = new Date(Date.now() - agoMs);
    fs.utimesSync(file, at, at);
  };
  write(path.join(cliDir, "package.json"), '{ "name": "everyapp", "type": "module" }', 10_000);
  write(path.join(cliDir, "src", "index.ts"), "export {};\n", 10_000);
  write(path.join(sdkDir, "package.json"), '{ "name": "@every-app/sdk" }', 10_000);
  write(path.join(sdkDir, "src", "index.ts"), "export {};\n", 10_000);
  write(path.join(sdkDir, "dist", "server", "index.js"), "export {};\n", 5_000);
  fs.mkdirSync(path.join(cliDir, "bin"));
  fs.copyFileSync(LAUNCHER, path.join(cliDir, "bin", "everyapp.js"));

  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "pnpm"), pnpm, { mode: 0o755 });
  const log = path.join(root, "rebuilds.log");
  fs.writeFileSync(log, "");
  return {
    root,
    cliDir,
    lockDir: path.join(root, "node_modules", ".cache", "everyapp", "rebuild.lock"),
    log,
    env: {
      ...process.env,
      PATH: [binDir, path.dirname(process.execPath), process.env["PATH"]].join(path.delimiter),
      LAUNCHER_TEST_LOG: log,
      NO_COLOR: "1",
    },
  };
}

function run(
  { cliDir, root, env }: Checkout,
  { nodeArgs = [], args = ["status"] }: { nodeArgs?: string[]; args?: string[] } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, path.join(cliDir, "bin", "everyapp.js"), ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const rebuilds = ({ log }: Checkout) =>
  fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes("tsup"));

/** A lock another everyapp left: its directory and the pid it wrote, `agoMs` old. */
function leaveLock({ lockDir }: Checkout, pid: number, agoMs = 0): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "pid"), String(pid));
  const at = new Date(Date.now() - agoMs);
  fs.utimesSync(lockDir, at, at);
}

describe("the launcher's rebuild", { timeout: 30_000 }, () => {
  it("happens once when two everyapps start together, and both run the built CLI", async () => {
    const tree = checkout();

    const [first, second] = await Promise.all([run(tree), run(tree)]);

    expect([first.code, second.code]).toEqual([0, 0]);
    expect([first.stdout, second.stdout]).toEqual(["ran\n", "ran\n"]);
    expect(rebuilds(tree)).toHaveLength(1);
    const updated = [first.stderr, second.stderr].filter((text) => text.includes("Updated everyapp CLI to"));
    expect(updated).toHaveLength(1);
    for (const { stderr } of [first, second]) {
      expect(stderr).not.toContain("ENOENT");
      expect(stderr).not.toContain("couldn't rebuild");
    }
    expect(fs.existsSync(tree.lockDir)).toBe(false);
  });

  it("waits for the everyapp holding the lock, then skips its own rebuild when dist is fresh", async () => {
    const tree = checkout();
    leaveLock(tree, process.pid);

    const running = run(tree);
    // The holder finishes: dist appears and the lock goes.
    await new Promise((resolve) => setTimeout(resolve, 700));
    fs.mkdirSync(path.join(tree.cliDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tree.cliDir, "dist", "index.js"), 'process.stdout.write("ran\\n");\n');
    fs.rmSync(tree.lockDir, { recursive: true, force: true });
    const result = await running;

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ran\n");
    expect(result.stderr).toContain("Waiting for another everyapp to finish rebuilding the CLI...");
    expect(result.stderr).not.toContain("Updated everyapp CLI to");
    expect(rebuilds(tree)).toEqual([]);
  });

  it("takes over a lock whose holder is gone", async () => {
    const tree = checkout();
    leaveLock(tree, NO_SUCH_PID);

    const result = await run(tree);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ran\n");
    expect(result.stderr).not.toContain("Waiting");
    expect(rebuilds(tree)).toHaveLength(1);
    expect(fs.existsSync(tree.lockDir)).toBe(false);
  });

  it("takes over a lock older than five minutes, whoever holds it", async () => {
    const tree = checkout();
    leaveLock(tree, process.pid, 6 * 60_000);

    const result = await run(tree);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ran\n");
    expect(rebuilds(tree)).toHaveLength(1);
    expect(fs.existsSync(tree.lockDir)).toBe(false);
  });

  it("releases the lock when the rebuild fails, so the next everyapp doesn't wait on it", async () => {
    const tree = checkout({ pnpm: FAILING_PNPM });

    const result = await run(tree);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    // The build's own output first, then what failed.
    expect(result.stderr).toContain("Error: Unexpected token in src/index.ts");
    expect(result.stderr).toContain(
      `everyapp: couldn't rebuild from this checkout: \`pnpm exec tsup --silent\` in ${tree.cliDir} exited 1.`,
    );
    expect(result.stderr).not.toContain("Updated everyapp CLI to");
    expect(rebuilds(tree)).toHaveLength(1);
    expect(fs.existsSync(tree.lockDir)).toBe(false);
  });
});

describe("the launcher on an old Node", { timeout: 30_000 }, () => {
  /** Node 18, as far as the launcher can tell. */
  const oldNode = (tree: Checkout): string[] => {
    const preload = path.join(tree.root, "old-node.cjs");
    fs.writeFileSync(
      preload,
      'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "18.19.0" } });\n',
    );
    return ["--require", preload];
  };

  it("says which Node it needs and stops, before anything is rebuilt", async () => {
    const tree = checkout();

    const result = await run(tree, { nodeArgs: oldNode(tree) });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "✗ everyapp needs Node.js 22.18.0 or newer; this is 18.19.0",
        "  The Cloudflare CLI loads cloudflare.config.ts with Node's built-in TypeScript support.",
        "  Fix: install Node 22 or 24, then run the command again",
        "",
      ].join("\n"),
    );
    expect(rebuilds(tree)).toEqual([]);
  });

  it("says it as one event under --json", async () => {
    const tree = checkout();

    const result = await run(tree, { nodeArgs: oldNode(tree), args: ["status", "--json"] });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      v: 1,
      type: "error",
      code: "UNSUPPORTED_RUNTIME",
      message: expect.stringContaining("everyapp needs Node.js 22.18.0 or newer; this is 18.19.0"),
      data: { fix: "install Node 22 or 24, then run the command again" },
    });
  });

  it("reaches that check with nothing newer than Node 18 in the way", () => {
    const source = fs.readFileSync(LAUNCHER, "utf8");
    // Static imports resolve before any statement runs: a name Node 18's
    // modules lack (node:util's styleText) is a SyntaxError there.
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["node:child_process", "node:fs", "node:path", "node:url"]);
    expect(source).not.toContain("styleText");
    // The version check comes before the first directory walk.
    expect(source.indexOf("olderThan(process.versions.node")).toBeLessThan(source.indexOf("readdirSync"));
  });
});
