/**
 * The app's own migration CLI (drizzle-kit, Prisma) against its Postgres
 * database: ./postgres.ts and ./prisma.ts. The database URL reaches the CLI
 * only in its environment, and anything it prints comes back with the URL
 * and password replaced.
 */
import { execa } from "execa";
import {
  parseOriginUrl,
  POSTGRES_URL_VARIABLE,
  redactSecrets,
} from "@/lib/app/deploySecrets";
import type { EveryAppError } from "@/lib/errors";
import { resolveLocalPackage } from "@/lib/local-package-bin";

const MIGRATE_TIMEOUT_MS = 10 * 60_000;

/** How a migration CLI runs: a seam, so tests need neither the CLI nor Postgres. */
export type MigrationCliRunner = (call: {
  /** The CLI's arguments. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * The app's own copy of a package's CLI, with this Node and `env` on top of
 * NODE_NO_WARNINGS; `missing` when the app doesn't have it.
 */
export function localPackageRunner({
  packageName,
  binName,
  env: extraEnv = {},
  missing,
}: {
  packageName: string;
  binName: string;
  env?: Record<string, string>;
  missing: () => EveryAppError;
}): MigrationCliRunner {
  return async ({ args, cwd, env }) => {
    let binPath: string;
    try {
      binPath = (await resolveLocalPackage(cwd, packageName, binName)).binPath;
    } catch {
      throw missing();
    }
    const run = await execa(process.execPath, [binPath, ...args], {
      cwd,
      env: { NODE_NO_WARNINGS: "1", ...extraEnv, ...env },
      stdin: "ignore",
      reject: false,
      timeout: MIGRATE_TIMEOUT_MS,
    });
    return {
      exitCode: run.timedOut ? 124 : (run.exitCode ?? 1),
      stdout: String(run.stdout ?? ""),
      stderr: String(run.stderr ?? ""),
    };
  };
}

/**
 * Run a migration CLI against `databaseUrl`; returns its stdout. A failure throws `failed(why)`,
 * `why` being the first line of its redacted output that matches a
 * `reasonPatterns` entry (tried in order), else its last line.
 */
export async function runMigrationCli({
  run,
  args,
  cwd,
  databaseUrl,
  reasonPatterns,
  failed,
}: {
  run: MigrationCliRunner;
  args: string[];
  cwd: string;
  databaseUrl: string;
  reasonPatterns: readonly RegExp[];
  failed: (why: string) => EveryAppError;
}): Promise<string> {
  const { password } = parseOriginUrl(databaseUrl, POSTGRES_URL_VARIABLE);
  const result = await run({
    args,
    cwd,
    env: { [POSTGRES_URL_VARIABLE]: databaseUrl },
  });
  if (result.exitCode === 0) return result.stdout;
  const output = redactSecrets(`${result.stderr}\n${result.stdout}`, [
    databaseUrl,
    password,
    encodeURIComponent(password),
  ]);
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const matching = reasonPatterns
    .map((pattern) => lines.find((line) => pattern.test(line)))
    .find((line) => line !== undefined);
  throw failed(matching ?? lines.at(-1) ?? `exit ${result.exitCode}`);
}
