import { applyLocalMigrations, legacyLocalStateNote } from "@/lib/app/localD1";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";

/** The same step `everyapp app d1 migrate --local` reports. */
const STEP = "migrations.local";

interface ApplyDevMigrationsOptions {
  cwd: string;
  manifest: EveryAppCliManifest;
  cf: CfRunner;
  out: EventSink;
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
}: ApplyDevMigrationsOptions): Promise<void> {
  const note = await legacyLocalStateNote(cwd);
  if (note) {
    out.emit({ type: "warning", code: "LEGACY_LOCAL_STATE", message: note });
  }
  out.emit({
    type: "step",
    step: STEP,
    status: "start",
    message: "Applying local database migrations...",
  });

  let result: Awaited<ReturnType<typeof applyLocalMigrations>>;
  try {
    result = await applyLocalMigrations({ cwd, manifest, cf });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.emit({ type: "step", step: STEP, status: "fail", data: { message } });
    // Every template and example app ships this script, and the
    // troubleshooting docs point at it, so it's the recipe to print rather
    // than the raw cf call.
    throw new EveryAppError(
      "MIGRATIONS_FAILED",
      [
        `Failed to apply local database migrations: ${message}`,
        "Run manually: pnpm run db:migrate:local",
        "Fix the migration error, then start dev again. Use --skip-migrations only if the local database is already usable.",
      ].join("\n"),
    );
  }

  if (result.status === "skipped") {
    out.emit({
      type: "step",
      step: STEP,
      status: "skip",
      data: { reason: result.reason },
    });
    return;
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
