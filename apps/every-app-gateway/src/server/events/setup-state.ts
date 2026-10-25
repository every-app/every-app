/**
 * `apps.setup_state` and the two events it drives (docs/design/
 * 2026-10-events-out.md, section 5): whether an app had every required
 * setting the last time the gateway evaluated its readiness. Wherever
 * that happens (the app lists through listedAppSetup, the perimeter's
 * setup gate through refuseUnreadyApp) the result comes here: the column
 * is read, written when it changed, and a change emits `app.needs_setup`
 * (with the unmet setting names, never values) or `app.ready`. A first
 * evaluation (null to anything) emits only `needs_setup`: an app that
 * was always ready is not news. The CLI writes the same column after
 * `configure`, `secret set|unset` and `deploy`, with its own outbox row.
 *
 * The lists run often, so the last state seen is kept per isolate for a
 * while and the column is read again only when the state differs or the
 * memory lapsed; a write always re-reads first, so two isolates that see
 * the same change emit it once at most per lapse.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { emit } from "./bus";
import { catalogue } from "./catalogue";
import { GATEWAY_ACTOR } from "./subjects";

type SetupState = "ready" | "needs_setup";

const REMEMBER_MS = 30_000;
const REMEMBER_MAX_ENTRIES = 500;
const remembered = new Map<string, { state: SetupState; until: number }>();

export function clearSetupStateMemoryForTests(): void {
  remembered.clear();
}

interface SetupStateInput {
  rowId: string;
  organizationId: string;
  /** The manifest id (the routing slug). */
  appId: string;
  /** The display name. */
  name: string;
  ready: boolean;
  /** The names of the settings that keep it closed, when not ready. */
  unmet: string[];
}

/**
 * Record an evaluation: write the column when it changed and emit the
 * transition. Never throws: a failure here must not break the list or
 * the request that evaluated the app.
 */
export async function recordSetupState(input: SetupStateInput): Promise<void> {
  const state: SetupState = input.ready ? "ready" : "needs_setup";
  const now = Date.now();
  const known = remembered.get(input.rowId);
  if (known && known.until > now && known.state === state) return;
  try {
    const [row] = await db
      .select({ setupState: apps.setupState })
      .from(apps)
      .where(
        and(
          eq(apps.id, input.rowId),
          eq(apps.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!row) return;
    const previous =
      row.setupState === "ready" || row.setupState === "needs_setup"
        ? row.setupState
        : null;
    if (previous !== state) {
      await db
        .update(apps)
        .set({ setupState: state })
        .where(
          and(
            eq(apps.id, input.rowId),
            eq(apps.organizationId, input.organizationId),
          ),
        );
      const app = { id: input.appId, rowId: input.rowId, name: input.name };
      if (state === "needs_setup") {
        await emit({
          organizationId: input.organizationId,
          actor: GATEWAY_ACTOR,
          ...catalogue.appNeedsSetup({ app, unmet: input.unmet }),
        });
      } else if (previous !== null) {
        await emit({
          organizationId: input.organizationId,
          actor: GATEWAY_ACTOR,
          ...catalogue.appReady({ app }),
        });
      }
    }
    remembered.delete(input.rowId);
    remembered.set(input.rowId, { state, until: now + REMEMBER_MS });
    if (remembered.size > REMEMBER_MAX_ENTRIES) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
  } catch (error) {
    console.warn("App setup state not recorded", {
      event: "app.setup_state_failed",
      appId: input.appId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
