import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { runWithRemoteD1 } from "@/lib/remote-d1";
import { verboseLogLines } from "@/lib/logging";
import { executeCommandWithFormatting } from "@/lib/formatting";
import { resolveLocalPackageBin } from "@/lib/local-package-bin";
import {
  cleanupTempDirectory,
  createTempDirectory,
  directoryExists,
} from "@/lib/file-operations";
import type { EveryAppManifest } from "@every-app/perimeter/manifest";

const MIGRATION_ARGS = ["migrate", "--config=drizzle-prod.config.ts"];
const DEFAULT_MIGRATIONS_DIR = "drizzle";

// An absent `migrations` field means drizzle against the first D1 binding, on
// both the deploy and dev-preflight paths. Diverging would silently skip the
// preflight for every app that doesn't spell the field out — which is all of
// the example apps.
function resolveMigrationBinding(
  d1Bindings: string[],
  migrations: EveryAppManifest["migrations"],
): string {
  const migrationBinding = migrations?.binding ?? d1Bindings[0]!;
  if (!d1Bindings.includes(migrationBinding)) {
    throw new Error(
      `Manifest migrations binding "${migrationBinding}" is not declared in resources.d1.`,
    );
  }
  return migrationBinding;
}

interface RunDrizzleMigrationsOptions {
  /** Working directory containing drizzle config */
  cwd: string;
  /** Remote D1 database ID. When omitted, falls back to generated config lookup. */
  d1DatabaseId?: string;
  /** Whether to show command output */
  verbose?: boolean;
}

interface RunAppMigrationsOptions {
  cwd: string;
  workerName: string;
  d1Bindings: string[];
  d1DatabaseIds: Record<string, string>;
  migrations?: EveryAppManifest["migrations"];
  verbose?: boolean;
}

interface RunD1SqlMigrationsOptions {
  cwd: string;
  binding: string;
  databaseName: string;
  databaseId: string;
  migrationsDir: string;
  verbose?: boolean;
}

interface RunLocalAppMigrationsOptions {
  cwd: string;
  d1Bindings: string[];
  migrations?: EveryAppManifest["migrations"];
  configPath: string;
  verbose?: boolean;
}

export async function runAppMigrations({
  cwd,
  workerName,
  d1Bindings,
  d1DatabaseIds,
  migrations,
  verbose = false,
}: RunAppMigrationsOptions): Promise<void> {
  if (d1Bindings.length === 0) {
    if (verbose) {
      console.log(
        chalk.dim("No D1 resources declared; skipping migrations.\n"),
      );
    }
    return;
  }

  const migrationBinding = resolveMigrationBinding(d1Bindings, migrations);

  const d1DatabaseId = d1DatabaseIds[migrationBinding];
  if (!d1DatabaseId) {
    throw new Error(
      `No provisioned D1 database ID found for binding "${migrationBinding}".`,
    );
  }

  if (!migrations || migrations.engine === "drizzle") {
    await runDrizzleMigrations({
      cwd,
      d1DatabaseId,
      verbose,
    });
    return;
  }

  if (!migrations.dir) {
    throw new Error(
      'migrations.dir is required when migrations.engine is "d1-sql".',
    );
  }

  await runD1SqlMigrations({
    cwd,
    binding: migrationBinding,
    databaseName: d1DatabaseNameForBinding(workerName, migrationBinding),
    databaseId: d1DatabaseId,
    migrationsDir: path.resolve(cwd, migrations.dir),
    verbose,
  });
}

/**
 * Run drizzle-kit migrations against a remote D1 database.
 * Throws on failure - callers should handle errors appropriately.
 */
export async function runDrizzleMigrations({
  cwd,
  d1DatabaseId,
  verbose = false,
}: RunDrizzleMigrationsOptions): Promise<void> {
  const { command, argsPrefix } = await resolveLocalPackageBin(
    cwd,
    "drizzle-kit",
    "drizzle-kit",
  );
  console.log(
    `\nRunning: project-local drizzle-kit ${MIGRATION_ARGS.join(" ")}`,
  );
  console.log(chalk.dim("  Running database migrations..."));

  verboseLogLines(
    verbose,
    "  Running any pending migrations against your remote D1 Database...",
  );

  await runWithRemoteD1(command, [...argsPrefix, ...MIGRATION_ARGS], {
    cwd,
    d1DatabaseId,
    verbose,
  });

  console.log(chalk.dim("  Migrations completed.\n"));
}

export async function runLocalAppMigrations({
  cwd,
  d1Bindings,
  migrations,
  configPath,
  verbose = false,
}: RunLocalAppMigrationsOptions): Promise<void> {
  if (d1Bindings.length === 0) {
    return;
  }

  const migrationBinding = resolveMigrationBinding(d1Bindings, migrations);

  const migrationsDir = path.resolve(
    cwd,
    migrations?.dir ?? DEFAULT_MIGRATIONS_DIR,
  );
  if (!(await directoryExists(migrationsDir))) {
    return;
  }

  console.log(chalk.dim("  Applying local database migrations..."));

  if (migrations?.engine === "d1-sql") {
    const { command, argsPrefix } = await resolveLocalPackageBin(
      cwd,
      "wrangler",
      "wrangler",
    );
    await executeCommandWithFormatting(
      command,
      [
        ...argsPrefix,
        "d1",
        "migrations",
        "apply",
        migrationBinding,
        "--local",
        "--persist-to",
        path.join(cwd, ".wrangler", "state"),
        "-c",
        configPath,
      ],
      {
        cwd,
        verbose,
        logCommandToConsole: false,
      },
    );
    console.log(chalk.dim("  Local migrations applied."));
    return;
  }

  // drizzle-kit talks to the local D1 file directly and fails if miniflare has
  // never created it — the case on a fresh clone, which is exactly when the dev
  // preflight matters. A throwaway query through wrangler makes miniflare
  // materialise the database first.
  if (
    !(await containsSqliteFile(
      path.join(cwd, ".wrangler", "state", "v3", "d1"),
    ))
  ) {
    const wrangler = await resolveLocalPackageBin(cwd, "wrangler", "wrangler");
    await executeCommandWithFormatting(
      wrangler.command,
      [
        ...wrangler.argsPrefix,
        "d1",
        "execute",
        migrationBinding,
        "--local",
        "--persist-to",
        path.join(cwd, ".wrangler", "state"),
        "-c",
        configPath,
        "--command",
        "SELECT 1;",
      ],
      {
        cwd,
        verbose,
        logCommandToConsole: false,
      },
    );
  }

  const drizzle = await resolveLocalPackageBin(
    cwd,
    "drizzle-kit",
    "drizzle-kit",
  );
  await executeCommandWithFormatting(
    drizzle.command,
    [...drizzle.argsPrefix, "migrate"],
    {
      cwd,
      verbose,
      logCommandToConsole: false,
    },
  );
  console.log(chalk.dim("  Local migrations applied."));
}

async function runD1SqlMigrations({
  cwd,
  binding,
  databaseName,
  databaseId,
  migrationsDir,
  verbose = false,
}: RunD1SqlMigrationsOptions): Promise<void> {
  const { command, argsPrefix } = await resolveLocalPackageBin(
    cwd,
    "wrangler",
    "wrangler",
  );
  console.log(
    `\nRunning: project-local wrangler d1 migrations apply ${binding} --remote -c <temp-config>`,
  );
  console.log(chalk.dim("  Running database migrations..."));

  const tmpDir = await createTempDirectory("everyapp-d1-migrations-");
  const wranglerConfigPath = path.join(tmpDir, "wrangler.d1-migrations.json");
  try {
    await fs.writeFile(
      wranglerConfigPath,
      JSON.stringify(
        {
          d1_databases: [
            {
              binding,
              database_name: databaseName,
              database_id: databaseId,
              migrations_dir: migrationsDir,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await executeCommandWithFormatting(
      command,
      [
        ...argsPrefix,
        "d1",
        "migrations",
        "apply",
        binding,
        "--remote",
        "-c",
        wranglerConfigPath,
      ],
      {
        cwd,
        verbose,
        logCommandToConsole: false,
      },
    );
  } finally {
    await cleanupTempDirectory({ tmpDir, verbose });
  }

  console.log(chalk.dim("  Migrations completed.\n"));
}

export function d1DatabaseNameForBinding(
  workerName: string,
  binding: string,
): string {
  return binding === "DB"
    ? workerName
    : `${workerName}-${binding.toLowerCase()}`;
}

async function containsSqliteFile(directory: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(directory, { recursive: true });
    return entries.some((entry) => entry.endsWith(".sqlite"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
