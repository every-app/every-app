import {
  LocalMigrationsSkipped,
  localMigrationsSource,
  migrateLocalDatabase,
} from "@/lib/app/localD1";
import type { CfRunner } from "@/lib/cf/runner";
import { errorMessage, EveryAppError } from "@/lib/errors";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { localMigrationsApplied, warnLegacyLocalState } from "../localMigrations";

const STEP = "dev.migrations";

interface ApplyDevMigrationsOptions {
  cwd: string;
  manifest: EveryAppCliManifest;
  cf: CfRunner;
  out: EventSink;
  /** --skip-migrations */
  skip: boolean;
}

/**
 * Apply pending migrations to the local database `cf dev` serves. Throws
 * `MIGRATIONS_FAILED` (dev doesn't start) when they don't apply.
 */
export async function applyDevMigrations({
  cwd,
  manifest,
  cf,
  out,
  skip,
}: ApplyDevMigrationsOptions): Promise<void> {
  await warnLegacyLocalState(cwd, out);
  if (skip) {
    out.emit({ type: "step", step: STEP, status: "skip", data: { reason: LocalMigrationsSkipped.Flag } });
    return;
  }
  // An app with nothing to apply shows no step at all.
  const source = await localMigrationsSource(cwd, manifest);
  if (source.status === "skipped") {
    out.emit({ type: "step", step: STEP, status: "skip", data: { reason: source.reason } });
    return;
  }

  out.emit({
    type: "step",
    step: STEP,
    status: "start",
    message: "Applying local migrations...",
  });
  let result: Awaited<ReturnType<typeof migrateLocalDatabase>>;
  try {
    result = await migrateLocalDatabase({ cwd, manifest, cf, ...source });
  } catch (error) {
    const message = errorMessage(error);
    out.emit({ type: "step", step: STEP, status: "fail", data: { message } });
    throw new EveryAppError(
      "MIGRATIONS_FAILED",
      [
        "A local migration failed",
        message,
        "Or start with --skip-migrations if the local database is already usable.",
      ].join("\n"),
      { data: { fix: `correct the migration, then run ${thisCommand()} again` } },
    );
  }
  localMigrationsApplied(out, STEP, result);
}
