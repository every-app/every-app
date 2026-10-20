/**
 * The local D1 database `cf dev` serves. Migrations go through
 * `cf d1 migrations apply --local` against the same state directory and
 * database id the app's `cloudflare.config.ts` gives it (`localD1Id`), for
 * both the drizzle and d1-sql engines.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { localD1Id } from "@every-app/sdk/cloudflare";
import { workerNameFor } from "@every-app/perimeter/manifest";
import { runCfJson, type CfRunner } from "@/lib/cf/runner";
import { D1MigrationsApplyOutput } from "@/lib/cf/schemas";
import {
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";

/** Where the Cloudflare Vite plugin keeps local state, relative to the app root. */
const LOCAL_STATE_DIR = ".cloudflare/state";
const DEFAULT_MIGRATIONS_DIR = "drizzle";
const MIGRATIONS_TIMEOUT_MS = 600_000;

type Skipped = { status: "skipped"; reason: "no_d1" | "no_migrations_dir" };

type LocalMigrationsResult =
  | { status: "applied"; applied: string[]; database: string }
  | Skipped;

/** The binding and directory the app's local migrations apply from, or why it has none. */
export async function localMigrationsSource(
  cwd: string,
  manifest: EveryAppCliManifest,
): Promise<{ status: "found"; binding: string; dir: string } | Skipped> {
  const d1Bindings = manifest.resources?.d1 ?? [];
  if (d1Bindings.length === 0) return { status: "skipped", reason: "no_d1" };

  const binding = resolveMigrationBinding(d1Bindings, manifest.migrations);
  const dir = manifest.migrations?.dir ?? DEFAULT_MIGRATIONS_DIR;
  if (!(await isDirectory(path.resolve(cwd, dir)))) {
    return { status: "skipped", reason: "no_migrations_dir" };
  }
  return { status: "found", binding, dir };
}

interface ApplyLocalMigrationsOptions {
  cwd: string;
  manifest: EveryAppCliManifest;
  cf: CfRunner;
}

export async function applyLocalMigrations({
  cwd,
  manifest,
  cf,
}: ApplyLocalMigrationsOptions): Promise<LocalMigrationsResult> {
  const source = await localMigrationsSource(cwd, manifest);
  if (source.status === "skipped") return source;
  return {
    status: "applied",
    ...(await migrateLocalDatabase({ cwd, manifest, cf, ...source })),
  };
}

/** Apply the migrations in `dir` to the local database of `binding`. */
export async function migrateLocalDatabase({
  cwd,
  manifest,
  cf,
  binding,
  dir,
}: ApplyLocalMigrationsOptions & { binding: string; dir: string }): Promise<{
  applied: string[];
  database: string;
}> {
  // cf accepts only a UUID or 32-hex id here, never a binding name.
  const database = localD1Id(workerNameFor(manifest.id), binding);
  const applied = await runCfJson(
    cf,
    {
      plane: "project",
      cwd,
      local: true,
      timeoutMs: MIGRATIONS_TIMEOUT_MS,
      env: devRegistryEnv(cwd),
      args: [
        "d1",
        "migrations",
        "apply",
        database,
        "--local",
        "--persist-to",
        LOCAL_STATE_DIR,
        "--dir",
        dir,
      ],
    },
    D1MigrationsApplyOutput,
  );
  return {
    applied: applied.map((migration) => migration.name),
    database,
  };
}

/**
 * Pin the dev registry (how local Workers find each other's service
 * bindings) to this checkout, for every process `everyapp` starts. The
 * default is one per user, so two worktrees of the same app would collide.
 */
export function devRegistryEnv(cwd: string): Record<string, string> {
  const registry = path.join(cwd, ".everyapp", "registry");
  return {
    CLOUDFLARE_REGISTRY_PATH: registry,
    MINIFLARE_REGISTRY_PATH: registry,
  };
}

/**
 * Apps started under Wrangler kept local data in `.wrangler/state`. Explain,
 * once there is no new state yet, why the old local data isn't there.
 */
export async function legacyLocalStateNote(
  cwd: string,
): Promise<string | null> {
  const legacy = await isDirectory(path.join(cwd, ".wrangler", "state"));
  const current = await isDirectory(path.join(cwd, LOCAL_STATE_DIR));
  if (!legacy || current) return null;
  return "Local data now lives in .cloudflare/state\nRows in the old .wrangler/state database weren't copied over.";
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
