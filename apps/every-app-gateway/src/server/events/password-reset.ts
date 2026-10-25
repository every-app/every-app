/**
 * `member.password_reset` (docs/design/2026-10-events-out.md, section 5):
 * Better Auth 1.7.7 calls `emailAndPassword.onPasswordReset` once a reset
 * completes, with the user and nothing else. Who started it is kept in
 * the counters table for the link's lifetime when an admin did (a link
 * handed over, or a mail the gateway sent), so the event can say `by`;
 * with no marker the person reset it themselves. The account spans
 * organizations, so the event goes to every organization the person is
 * a member of (one, on a self-hosted gateway).
 */
import { eq } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { db } from "@/db";
import { members } from "@/db/schema";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";
import { emit } from "./bus";
import { catalogue } from "./catalogue";
import type { EventUser } from "./catalogue";
import { actorOf } from "./subjects";

type PasswordResetOrigin = "self" | "admin_link" | "admin_email";

// Better Auth's reset links live an hour; so does the marker.
const MARKER_TTL_MS = 60 * 60 * 1000;

function markerKey(by: Exclude<PasswordResetOrigin, "self">, userId: string) {
  return `events:password_reset:${by}:${userId}`;
}

/** An admin started a reset for this user: remember how, for the event. */
export async function notePasswordResetOrigin(
  userId: string,
  by: Exclude<PasswordResetOrigin, "self">,
): Promise<void> {
  try {
    await RateLimitCounterRepository.increment(
      [markerKey(by, userId)],
      new Date(Date.now() + MARKER_TTL_MS),
    );
  } catch {
    // Best effort: without the marker the event says "self".
  }
}

async function passwordResetOrigin(
  userId: string,
): Promise<PasswordResetOrigin> {
  try {
    const counts = await RateLimitCounterRepository.read([
      markerKey("admin_link", userId),
      markerKey("admin_email", userId),
    ]);
    if (counts.get(markerKey("admin_link", userId))) return "admin_link";
    if (counts.get(markerKey("admin_email", userId))) return "admin_email";
  } catch {
    // As above.
  }
  return "self";
}

/**
 * Emit the reset to each organization the person belongs to. Better Auth
 * awaits this after the password changed, so nothing in it rejects: a
 * read that fails is logged as an emit that failed.
 */
export async function announcePasswordReset(user: EventUser): Promise<void> {
  let memberships: Array<{ organizationId: string }>;
  let by: PasswordResetOrigin;
  try {
    [by, memberships] = await Promise.all([
      passwordResetOrigin(user.id),
      db
        .select({ organizationId: members.organizationId })
        .from(members)
        .where(eq(members.userId, user.id)),
    ]);
  } catch (error) {
    logEvent(
      "events.emit_failed",
      {
        type: "member.password_reset",
        org: null,
        message: error instanceof Error ? error.message : String(error),
      },
      "error",
    );
    return;
  }
  for (const membership of memberships) {
    await emit({
      organizationId: membership.organizationId,
      actor: by === "self" ? actorOf(user) : { kind: "gateway" },
      ...catalogue.memberPasswordReset({ user, by }),
    });
  }
}
