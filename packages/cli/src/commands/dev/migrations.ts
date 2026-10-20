import {
  legacyLocalStateNote,
  localMigrationsSource,
  migrateLocalDatabase,
} from "@/lib/app/localD1";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";

const STEP = "dev.migrations";

/** Why dev applied no migrations (`data.reason` of its skipped step). */
enum MigrationsSkipped {
  /** --skip-migrations */
  Flag = "flag",
  NoD1 = "no_d1",
  NoMigrationsDir = "no_migrations_dir",
}

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
  const note = await legacyLocalStateNote(cwd);
  if (note) {
    out.emit({ type: "warning", code: "LEGACY_LOCAL_STATE", message: note });
  }
  if (skip) {
    out.emit({ type: "step", step: STEP, status: "skip", data: { reason: MigrationsSkipped.Flag } });
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
    const message = error instanceof Error ? error.message : String(error);
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
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message:
      result.applied.length > 0
        ? `Applied ${result.applied.join(", ")}.`
        : "The local database is up to date.",
    data: { database: result.database, applied: result.applied },
  });
}
