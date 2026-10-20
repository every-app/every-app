/**
 * Production Postgres migrations on the "prisma" engine (migrations.engine
 * "prisma", dialect "postgresql"): the app's own `prisma migrate deploy`,
 * with its prisma.config.ts, against POSTGRES_DATABASE_URL from the app's
 * secrets file. Prisma keeps its own journal table (`_prisma_migrations`),
 * so a database that is up to date stays as it is, and it refuses a
 * database whose schema it didn't write (P3005) instead of guessing.
 *
 * Like the drizzle path (./postgres.ts) it runs before the upload, so a
 * failed migration leaves the version that is serving untouched, and the
 * database's own backups are the way back. The URL reaches Prisma only in
 * its environment (the app's prisma.config.ts reads
 * `process.env.POSTGRES_DATABASE_URL`), and anything it prints comes back
 * with the URL and password replaced (./localCli.ts).
 *
 * D1 apps on Prisma don't come here: they ship Prisma's generated SQL
 * through the "d1-sql" engine, with `--> statement-breakpoint` markers.
 */
import { APP_SECRETS_FILE, POSTGRES_URL_VARIABLE } from "@/lib/app/deploySecrets";
import { EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";
import {
  localPackageRunner,
  runMigrationCli,
  type MigrationCliRunner,
} from "./localCli";

/** The app's own Prisma CLI, with this Node. */
function localPrisma(): MigrationCliRunner {
  return localPackageRunner({
    packageName: "prisma",
    binName: "prisma",
    // No update notice in the output a failure repeats.
    env: { PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    missing: () =>
      new EveryAppError(
        "PRISMA_MISSING",
        'Prisma isn\'t installed in this app\nPrisma migrations (migrations.engine "prisma") run the app\'s own Prisma CLI. Nothing was migrated or uploaded.',
        { fix: "add prisma to devDependencies", rerun: thisCommand() },
      ),
  });
}

export async function migratePrismaPostgres({
  cwd,
  databaseUrl,
  config,
  run = localPrisma(),
}: {
  cwd: string;
  databaseUrl: string;
  /** The app's prisma.config.ts, relative to `cwd`; Prisma's own lookup when unset. */
  config?: string;
  run?: MigrationCliRunner;
}): Promise<void> {
  await runMigrationCli({
    run,
    args: ["migrate", "deploy", ...(config ? ["--config", config] : [])],
    cwd,
    databaseUrl,
    // Prisma's own errors start with their code (P1001, P3005, ...).
    reasonPatterns: [/\bP\d{4}\b/, /error/i],
    failed: (why) =>
      new EveryAppError(
        "MIGRATION_FAILED",
        `prisma migrate deploy couldn't migrate the app's Postgres database\n${why}. Nothing was uploaded.`,
        {
          fix: `check ${POSTGRES_URL_VARIABLE} in ${APP_SECRETS_FILE}, the app's prisma.config.ts (its datasource reads process.env.${POSTGRES_URL_VARIABLE}) and the migrations`,
          rerun: thisCommand(),
        },
      ),
  });
}
