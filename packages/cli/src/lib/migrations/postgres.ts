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
 * prints comes back with the URL and password replaced.
 */
import { execa } from "execa";
import {
  APP_SECRETS_FILE,
  parseOriginUrl,
  POSTGRES_URL_VARIABLE,
  redactSecrets,
} from "@/lib/app/deploySecrets";
import { EveryAppError } from "@/lib/errors";
import { resolveLocalPackage } from "@/lib/local-package-bin";

const MIGRATE_TIMEOUT_MS = 10 * 60_000;

/** How drizzle-kit runs: a seam, so tests need no Postgres. */
export type DrizzleKitRunner = (call: {
  /** drizzle-kit's arguments. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** The app's own drizzle-kit, with this Node. */
function localDrizzleKit(): DrizzleKitRunner {
  return async ({ args, cwd, env }) => {
    let binPath: string;
    try {
      binPath = (await resolveLocalPackage(cwd, "drizzle-kit", "drizzle-kit"))
        .binPath;
    } catch {
      throw new EveryAppError(
        "DRIZZLE_KIT_MISSING",
        "Postgres migrations run the app's own drizzle-kit, which isn't installed here: add it to devDependencies, then deploy again. Nothing was migrated or uploaded.",
      );
    }
    const run = await execa(process.execPath, [binPath, ...args], {
      cwd,
      env: { NODE_NO_WARNINGS: "1", ...env },
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
  run?: DrizzleKitRunner;
}): Promise<void> {
  const { password } = parseOriginUrl(databaseUrl, POSTGRES_URL_VARIABLE);
  const result = await run({
    args: ["migrate", ...(config ? ["--config", config] : [])],
    cwd,
    env: { [POSTGRES_URL_VARIABLE]: databaseUrl },
  });
  if (result.exitCode === 0) return;
  const output = redactSecrets(`${result.stderr}\n${result.stdout}`, [
    databaseUrl,
    password,
    encodeURIComponent(password),
  ]);
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const why =
    lines.find((line) => /error/i.test(line)) ??
    lines.at(-1) ??
    `exit ${result.exitCode}`;
  throw new EveryAppError(
    "MIGRATION_FAILED",
    `drizzle-kit couldn't migrate the app's Postgres database (${why}). Nothing was uploaded; check ${POSTGRES_URL_VARIABLE} in ${APP_SECRETS_FILE} and the migrations, then deploy again.`,
  );
}
