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
 * with the URL and password replaced.
 *
 * D1 apps on Prisma don't come here: they ship Prisma's generated SQL
 * through the "d1-sql" engine, with `--> statement-breakpoint` markers.
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

/** How the Prisma CLI runs: a seam, so tests need neither Prisma nor Postgres. */
export type PrismaRunner = (call: {
  /** The Prisma CLI's arguments. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** The app's own Prisma CLI, with this Node. */
function localPrisma(): PrismaRunner {
  return async ({ args, cwd, env }) => {
    let binPath: string;
    try {
      binPath = (await resolveLocalPackage(cwd, "prisma", "prisma")).binPath;
    } catch {
      throw new EveryAppError(
        "PRISMA_MISSING",
        'Prisma migrations (migrations.engine "prisma") run the app\'s own Prisma CLI, which isn\'t installed here: add prisma to devDependencies, then deploy again. Nothing was migrated or uploaded.',
      );
    }
    const run = await execa(process.execPath, [binPath, ...args], {
      cwd,
      env: {
        NODE_NO_WARNINGS: "1",
        // No update notice in the output a failure repeats.
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
        ...env,
      },
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
  run?: PrismaRunner;
}): Promise<void> {
  const { password } = parseOriginUrl(databaseUrl, POSTGRES_URL_VARIABLE);
  const result = await run({
    args: ["migrate", "deploy", ...(config ? ["--config", config] : [])],
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
  // Prisma's own errors start with their code (P1001, P3005, ...).
  const why =
    lines.find((line) => /\bP\d{4}\b/.test(line)) ??
    lines.find((line) => /error/i.test(line)) ??
    lines.at(-1) ??
    `exit ${result.exitCode}`;
  throw new EveryAppError(
    "MIGRATION_FAILED",
    `prisma migrate deploy couldn't migrate the app's Postgres database (${why}). Nothing was uploaded; check ${POSTGRES_URL_VARIABLE} in ${APP_SECRETS_FILE}, the app's prisma.config.ts (its datasource reads process.env.${POSTGRES_URL_VARIABLE}) and the migrations, then deploy again.`,
  );
}
