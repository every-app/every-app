/**
 * Run `cf … --local` against the gateway's local D1 database (the one
 * `cf dev` serves from .cloudflare/state), the way the everyapp CLI does:
 * cf sometimes prints its whole JSON result and then never exits, so once
 * stdout parses and the process has been quiet for 2s, its process group is
 * stopped and the result kept.
 *
 * Usage: node scripts/cf-local.mjs migrate   (pnpm run db:migrate:local)
 * Other scripts import runCfLocal() and LOCAL_D1_ID.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = ".cloudflare/state";
const IDLE_MS = 2_000;
const TIMEOUT_MS = 120_000;
const PROCESS_GROUPS = process.platform !== "win32";

/** The 32-hex local id cloudflare.config.ts gives the gateway's dev D1. */
export const LOCAL_D1_ID = createHash("sha256")
  .update("every-app-gateway:DB")
  .digest("hex")
  .slice(0, 32);

function cfBinary() {
  const require = createRequire(path.join(GATEWAY_DIR, "package.json"));
  const packageJson = require.resolve("cf/package.json");
  const { bin } = JSON.parse(readFileSync(packageJson, "utf8"));
  return path.resolve(path.dirname(packageJson), bin.cf ?? bin);
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text.trim()) };
  } catch {
    return { ok: false };
  }
}

/** Run `cf <args> --local --persist-to .cloudflare/state`; resolves its JSON output. */
export function runCfLocal(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cfBinary(), ...args, "--local", "--persist-to", STATE_DIR],
      {
        cwd: GATEWAY_DIR,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: PROCESS_GROUPS,
      },
    );
    let stdout = "";
    let stderr = "";
    let idle;
    let settled = false;
    const stop = () => {
      try {
        if (PROCESS_GROUPS) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(idle);
      outcome();
    };
    const deadline = setTimeout(() => {
      stop();
      finish(() =>
        reject(new Error(`cf ${args.join(" ")} timed out\n${stderr}`)),
      );
    }, TIMEOUT_MS);
    const watch = () => {
      if (!idle && !parseJson(stdout).ok) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        stop();
        finish(() => resolve(parseJson(stdout).value));
      }, IDLE_MS);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      watch();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      watch();
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        const parsed = parseJson(stdout);
        if (code === 0 && parsed.ok) resolve(parsed.value);
        else
          reject(
            new Error(
              `cf ${args.join(" ")} failed\n${stderr || stdout}`.trim(),
            ),
          );
      });
    });
  });
}

/** Apply the gateway's migrations to the local D1 database. */
async function migrate() {
  const applied = await runCfLocal([
    "d1",
    "migrations",
    "apply",
    LOCAL_D1_ID,
    "--dir",
    "drizzle",
  ]);
  const names = Array.isArray(applied) ? applied.map((m) => m.name) : [];
  console.log(
    names.length > 0
      ? `Applied ${names.join(", ")}.`
      : "The local database is up to date.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2);
  if (command !== "migrate") {
    console.error("Usage: node scripts/cf-local.mjs migrate");
    process.exit(1);
  }
  migrate().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
