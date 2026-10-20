/** What `db migrate` and `dev` say about the local database's migrations. */
import { legacyLocalStateNote } from "@/lib/app/localD1";
import type { EventSink } from "@/lib/output/events";

/** Warn when the app's local data is still where Wrangler kept it. */
export async function warnLegacyLocalState(cwd: string, out: EventSink): Promise<void> {
  const note = await legacyLocalStateNote(cwd);
  if (note) {
    out.emit({ type: "warning", code: "LEGACY_LOCAL_STATE", message: note });
  }
}

/** The local migrations step done on `step`: what it applied, or that nothing was pending. */
export function localMigrationsApplied(
  out: EventSink,
  step: string,
  result: { database: string; applied: string[] },
): void {
  out.emit({
    type: "step",
    step,
    status: "ok",
    message:
      result.applied.length > 0
        ? `Applied ${result.applied.join(", ")}.`
        : "The local database is up to date.",
    data: { database: result.database, applied: result.applied },
  });
}
