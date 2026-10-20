/**
 * Production Postgres migrations (migrations.dialect "postgresql"): the
 * app's own `drizzle-kit migrate`, with its drizzle config, against
 * POSTGRES_DATABASE_URL from the app's secrets file. drizzle-kit keeps its
 * own journal table, so a database that is up to date stays as it is.
 *
 * Like the D1 migrations it runs before the upload, so a failed migration
 * leaves the version that is serving untouched. Postgres has no Time
 * Travel bookmark: the database's own backups (PlanetScale's, say) are the
 * way back.
 *
 * The URL reaches drizzle-kit only in its environment, and anything it
 * prints comes back with the URL and password replaced (./localCli.ts).
 */
import { APP_SECRETS_FILE, POSTGRES_URL_VARIABLE } from "@/lib/app/deploySecrets";
import { EveryAppError } from "@/lib/errors";
import {
  localPackageRunner,
  runMigrationCli,
  type MigrationCliRunner,
} from "./localCli";

/** The app's own drizzle-kit, with this Node. */
function localDrizzleKit(): MigrationCliRunner {
  return localPackageRunner({
    packageName: "drizzle-kit",
    binName: "drizzle-kit",
    missing: () =>
      new EveryAppError(
        "DRIZZLE_KIT_MISSING",
        "Postgres migrations need drizzle-kit, which isn't installed\nNothing was migrated or uploaded.",
        { fix: "add drizzle-kit to devDependencies, then deploy again" },
      ),
  });
}

export async function migratePostgres({
  cwd,
  databaseUrl,
  config,
  run = localDrizzleKit(),
}: {
  cwd: string;
  databaseUrl: string;
  /** The app's drizzle config, relative to `cwd`; drizzle-kit's default when unset. */
  config?: string;
  run?: MigrationCliRunner;
}): Promise<void> {
  await runMigrationCli({
    run,
    args: ["migrate", ...(config ? ["--config", config] : [])],
    cwd,
    databaseUrl,
    reasonPatterns: [/error/i],
    failed: (why) =>
      new EveryAppError(
        "MIGRATION_FAILED",
        `drizzle-kit couldn't migrate the Postgres database\n${why}. Nothing was uploaded.`,
        { fix: `check ${POSTGRES_URL_VARIABLE} in ${APP_SECRETS_FILE} and the migrations` },
      ),
  });
}
